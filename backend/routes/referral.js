/* routes/referral.js — FIN-02 Реферальна система.
   Коди/посилання, трекінг кліків, привʼязка нового клієнта до реферера,
   автонарахування винагороди ОБОМ (реферер+новачок) при першому оплаченому візиті,
   MLM L2 (опціонально), антифрод (самореферал/дублі), воронка-аналітика.
   Награда нараховується через loyalty_ledger (як скрізь у CRM) → нуль дублювання бонус-движка.
   Доступ: GET = reports.read, мутації = reports.finance. track-click/attribute — reports.read (виклик з фронту запису). */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'reports.read' : 'reports.finance';
  return requirePerm(perm)(req, res, next);
});

// SVS-XXXX (без 0/O/1/I)
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'SVS-' + Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
}

// Налаштування програми (створює дефолт якщо немає)
async function getSettings() {
  let s = await q(`SELECT * FROM referral_program_settings ORDER BY id LIMIT 1`);
  if (!s.length) s = await q(`INSERT INTO referral_program_settings DEFAULT VALUES RETURNING *`);
  return s[0];
}

// Код клієнта (створює якщо немає)
async function ensureCode(clientId) {
  const id = parseInt(clientId, 10);
  if (!id) return null;
  let c = await q(`SELECT * FROM referral_codes WHERE client_id=$1 ORDER BY id LIMIT 1`, [id]);
  if (c.length) return c[0];
  for (let i = 0; i < 6; i++) {
    const code = genCode();
    const r = await q(
      `INSERT INTO referral_codes (client_id, code, short_path) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, code) DO NOTHING RETURNING *`,
      [id, code, `/r/${code}`]).catch(() => []);
    if (r.length) return r[0];
  }
  return null;
}

// Нарахування винагороди отримувачу. bonus → loyalty_ledger; discount/free_service → фіксуємо як issued (застосує каса).
async function issueReward(client, referralId, recipientId, role, type, amount, level) {
  const amt = Number(amount) || 0;
  if (!recipientId || amt <= 0) return null;
  let ledgerId = null;
  if (type === 'bonus') {
    const pts = Math.round(amt);
    const led = await client.query(
      `INSERT INTO loyalty_ledger (client_id, delta, reason, ref_id, ref_type)
       VALUES ($1,$2,$3,$4,'referral') RETURNING id`,
      [recipientId, pts, `referral-${role}`, String(referralId)]);
    ledgerId = led.rows[0].id;
    await client.query(`UPDATE clients SET loyalty_points = COALESCE(loyalty_points,0) + $2 WHERE id=$1`, [recipientId, pts]);
  }
  const rw = await client.query(
    `INSERT INTO referral_rewards (referral_id, recipient_id, recipient_role, reward_type, reward_amount, level, status, ledger_id, issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,'issued',$7,NOW()) RETURNING id`,
    [referralId, recipientId, role, type, amt, level, ledgerId]);
  return rw.rows[0].id;
}

// ── Налаштування ──
router.get('/settings', async (_req, res) => {
  try { res.json(await getSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const s = await getSettings();
    const allowed = ['name', 'referrer_reward_type', 'referrer_reward_amount', 'referee_reward_type', 'referee_reward_amount',
      'activation_event', 'min_check_amount', 'attribution_window_days', 'max_rewards_per_month', 'max_rewards_total',
      'mlm_enabled', 'mlm_levels', 'mlm_l2_percent', 'mlm_l3_percent', 'is_active'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.json(s);
    vals.push(s.id);
    const r = await q(`UPDATE referral_program_settings SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    logAction(req, 'referral.settings_update', { id: s.id });
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Код/посилання клієнта ──
router.get('/code/:client_id', async (req, res) => {
  try {
    const c = await ensureCode(req.params.client_id);
    if (!c) return res.status(400).json({ error: 'client_id некоректний' });
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent('https://svs.salon' + c.short_path)}`;
    res.json({ ...c, qr_code_url: qrUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/code/:client_id/regenerate', async (req, res) => {
  try {
    const id = parseInt(req.params.client_id, 10);
    await q(`UPDATE referral_codes SET is_active=false WHERE client_id=$1`, [id]);
    // новий код
    let created = null;
    for (let i = 0; i < 6; i++) {
      const code = genCode();
      const r = await q(`INSERT INTO referral_codes (client_id, code, short_path) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING *`, [id, code, `/r/${code}`]).catch(() => []);
      if (r.length) { created = r[0]; break; }
    }
    logAction(req, 'referral.code_regenerate', { client_id: id });
    res.json(created || { error: 'не вдалось згенерувати' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Трекінг кліку ──
router.post('/track-click', async (req, res) => {
  try {
    const { code, utm_source, utm_medium, device_fingerprint } = req.body || {};
    const rc = await q(`SELECT id FROM referral_codes WHERE code=$1 AND is_active=true`, [String(code || '').trim()]);
    if (!rc.length) return res.status(404).json({ error: 'код не знайдено' });
    await q(`INSERT INTO referral_clicks (referral_code_id, ip_address, user_agent, device_fingerprint, utm_source, utm_medium)
             VALUES ($1,$2,$3,$4,$5,$6)`,
      [rc[0].id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 400), device_fingerprint || null, utm_source || null, utm_medium || null]);
    await q(`UPDATE referral_codes SET total_clicks = total_clicks + 1 WHERE id=$1`, [rc[0].id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Привʼязка нового клієнта до реферера за кодом ──
router.post('/attribute', async (req, res) => {
  try {
    const { code, referee_id } = req.body || {};
    const refeId = parseInt(referee_id, 10);
    if (!code || !refeId) return res.status(400).json({ error: 'code і referee_id обовʼязкові' });
    const rc = await q(`SELECT * FROM referral_codes WHERE code=$1 AND is_active=true`, [String(code).trim()]);
    if (!rc.length) return res.status(404).json({ error: 'код не знайдено' });
    const referrerId = rc[0].client_id;
    // антифрод: самореферал
    if (referrerId === refeId) return res.status(400).json({ error: 'самореферал заборонено' });
    const fraud = {};
    const both = await q(`SELECT id, phone, email FROM clients WHERE id = ANY($1)`, [[referrerId, refeId]]);
    const rr = both.find(x => x.id === referrerId), re = both.find(x => x.id === refeId);
    if (rr && re) {
      if (rr.phone && re.phone && rr.phone === re.phone) fraud.same_phone = true;
      if (rr.email && re.email && rr.email.toLowerCase() === re.email.toLowerCase()) fraud.same_email = true;
    }
    // дубль: новачок уже привʼязаний
    const exists = await q(`SELECT id FROM referrals WHERE referee_id=$1`, [refeId]);
    if (exists.length) return res.status(409).json({ error: 'клієнт вже привʼязаний до реферера', referral_id: exists[0].id });
    const isFraud = Object.keys(fraud).length > 0;
    const ins = await q(
      `INSERT INTO referrals (referrer_id, referee_id, referral_code_id, level, status, registered_at, fraud_flags,
                              referrer_phone, invited_phone, bonus_amount)
       VALUES ($1,$2,$3,1,$4,NOW(),$5,$6,$7,0) RETURNING id, status`,
      [referrerId, refeId, rc[0].id, isFraud ? 'under_review' : 'pending', isFraud ? JSON.stringify(fraud) : null,
       rr?.phone || '', re?.phone || '']);
    await q(`UPDATE referral_codes SET total_referrals = total_referrals + 1 WHERE id=$1`, [rc[0].id]);
    // позначити останній клік сконвертованим
    await q(`UPDATE referral_clicks SET converted=true WHERE id = (SELECT id FROM referral_clicks WHERE referral_code_id=$1 AND converted=false ORDER BY created_at DESC LIMIT 1)`, [rc[0].id]);
    logAction(req, 'referral.attribute', { referral_id: ins[0].id, referrer_id: referrerId, referee_id: refeId, fraud: isFraud });
    res.json({ ok: true, referral_id: ins[0].id, status: ins[0].status, fraud_flags: isFraud ? fraud : null });
  } catch (e) {
    if (String(e.message).includes('ux_referrals_referee')) return res.status(409).json({ error: 'клієнт вже привʼязаний' });
    res.status(500).json({ error: e.message });
  }
});

// Перевірка чи виконано умову активації для referee
async function checkQualified(refeId, st) {
  if (st.activation_event === 'registration') return { ok: true };
  // перший оплачений візит = appointments done з ціною
  const v = await q(
    `SELECT COALESCE(SUM(price),0)::numeric total, COUNT(*)::int cnt, MIN(starts_at) first_at
       FROM appointments WHERE client_id=$1 AND status='done'`, [refeId]);
  const cnt = v[0].cnt, total = Number(v[0].total);
  if (!cnt) return { ok: false };
  if (st.activation_event === 'min_check' && st.min_check_amount && total < Number(st.min_check_amount)) return { ok: false };
  return { ok: true, first_at: v[0].first_at, total };
}

// Видати винагороди по одному рефералу (ідемпотентно — транзакція)
async function rewardReferral(referralId) {
  const st = await getSettings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(`SELECT * FROM referrals WHERE id=$1 FOR UPDATE`, [referralId])).rows[0];
    if (!r || !r.referee_id) { await client.query('ROLLBACK'); return { skip: 'no_referral' }; }
    if (['rewarded', 'rejected'].includes(r.status)) { await client.query('ROLLBACK'); return { skip: r.status }; }
    if (r.status === 'under_review') { await client.query('ROLLBACK'); return { skip: 'under_review' }; }
    const qual = await checkQualified(r.referee_id, st);
    if (!qual.ok) { await client.query('ROLLBACK'); return { skip: 'not_qualified' }; }
    // ліміти реферера
    if (st.max_rewards_total) {
      const tot = (await client.query(`SELECT COUNT(*)::int c FROM referral_rewards WHERE recipient_id=$1 AND recipient_role='referrer' AND status='issued'`, [r.referrer_id])).rows[0].c;
      if (tot >= st.max_rewards_total) { await client.query('ROLLBACK'); return { skip: 'limit_total' }; }
    }
    if (st.max_rewards_per_month) {
      const m = (await client.query(`SELECT COUNT(*)::int c FROM referral_rewards WHERE recipient_id=$1 AND recipient_role='referrer' AND status='issued' AND issued_at >= date_trunc('month', NOW())`, [r.referrer_id])).rows[0].c;
      if (m >= st.max_rewards_per_month) { await client.query('ROLLBACK'); return { skip: 'limit_month' }; }
    }
    // винагорода новачку + рефереру (L1)
    await issueReward(client, referralId, r.referee_id, 'referee', st.referee_reward_type, st.referee_reward_amount, 1);
    await issueReward(client, referralId, r.referrer_id, 'referrer', st.referrer_reward_type, st.referrer_reward_amount, 1);
    // MLM L2: реферер реферера
    if (st.mlm_enabled && st.mlm_levels >= 2) {
      const up = (await client.query(`SELECT referrer_id FROM referrals WHERE referee_id=$1 AND status IN ('rewarded','qualified','pending')`, [r.referrer_id])).rows[0];
      if (up && up.referrer_id && up.referrer_id !== r.referee_id) {
        const l2 = Number(st.referrer_reward_amount) * Number(st.mlm_l2_percent) / 100;
        await issueReward(client, referralId, up.referrer_id, 'referrer', st.referrer_reward_type, l2, 2);
      }
    }
    await client.query(
      `UPDATE referrals SET status='rewarded', first_visit_at=COALESCE(first_visit_at,$2), qualified_at=COALESCE(qualified_at,NOW()), rewarded_at=NOW() WHERE id=$1`,
      [referralId, qual.first_at || null]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    return { error: e.message };
  } finally {
    client.release();
  }
}

// ── Ручна видача / автоскан ──
router.post('/:id/qualify', async (req, res) => {
  try {
    const out = await rewardReferral(parseInt(req.params.id, 10));
    if (out.error) return res.status(500).json(out);
    logAction(req, 'referral.qualify', { id: req.params.id, result: out });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const r = await q(`UPDATE referrals SET status='rejected', rejection_reason=$2 WHERE id=$1 AND status NOT IN ('rewarded') RETURNING id`,
      [parseInt(req.params.id, 10), (req.body?.reason || '').slice(0, 200)]);
    if (!r.length) return res.status(409).json({ error: 'не знайдено або вже винагороджено' });
    logAction(req, 'referral.reject', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Автоскан усіх pending → видати тим, хто виконав умову
router.post('/process', async (req, res) => {
  try {
    const pend = await q(`SELECT id FROM referrals WHERE status='pending' AND referee_id IS NOT NULL ORDER BY id LIMIT 500`);
    let rewarded = 0, skipped = 0;
    for (const row of pend) {
      const out = await rewardReferral(row.id);
      if (out.ok) rewarded++; else skipped++;
    }
    logAction(req, 'referral.process', { rewarded, skipped });
    res.json({ ok: true, scanned: pend.length, rewarded, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Список рефералів ──
router.get('/', async (req, res) => {
  try {
    const w = [`r.referee_id IS NOT NULL`], p = [];
    if (req.query.status) { p.push(req.query.status); w.push(`r.status=$${p.length}`); }
    if (req.query.referrer_id) { p.push(parseInt(req.query.referrer_id, 10)); w.push(`r.referrer_id=$${p.length}`); }
    const rows = await q(
      `SELECT r.id, r.referrer_id, r.referee_id, r.status, r.level, r.registered_at, r.first_visit_at, r.rewarded_at,
              r.fraud_flags, rr.name AS referrer_name, re.name AS referee_name, rc.code
         FROM referrals r
         LEFT JOIN clients rr ON rr.id=r.referrer_id
         LEFT JOIN clients re ON re.id=r.referee_id
         LEFT JOIN referral_codes rc ON rc.id=r.referral_code_id
        WHERE ${w.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`, p);
    res.json({ referrals: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/analytics', async (_req, res) => {
  try {
    const funnel = (await q(
      `SELECT COUNT(*) FILTER (WHERE TRUE)::int AS attributed,
              COUNT(*) FILTER (WHERE status='rewarded')::int AS rewarded,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='under_review')::int AS review,
              COUNT(*) FILTER (WHERE status='rejected')::int AS rejected
         FROM referrals WHERE referee_id IS NOT NULL`))[0];
    const clicks = (await q(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE converted)::int converted FROM referral_clicks`))[0];
    const rewardSum = (await q(`SELECT COALESCE(SUM(reward_amount),0)::numeric total, COUNT(*)::int cnt FROM referral_rewards WHERE status='issued'`))[0];
    const top = await q(
      `SELECT r.referrer_id, c.name, c.phone, COUNT(*)::int referrals,
              COUNT(*) FILTER (WHERE r.status='rewarded')::int rewarded
         FROM referrals r LEFT JOIN clients c ON c.id=r.referrer_id
        WHERE r.referee_id IS NOT NULL GROUP BY r.referrer_id, c.name, c.phone
        ORDER BY referrals DESC LIMIT 10`);
    // LTV приведених vs середній (грубо: total_spent)
    const ltv = (await q(
      `SELECT COALESCE(AVG(c.total_spent),0)::numeric referred_ltv,
              (SELECT COALESCE(AVG(total_spent),0)::numeric FROM clients) AS avg_ltv
         FROM clients c WHERE c.id IN (SELECT referee_id FROM referrals WHERE referee_id IS NOT NULL)`))[0];
    const conv = clicks.total ? +(funnel.attributed / clicks.total * 100).toFixed(1) : 0;
    res.json({
      funnel: { clicks: clicks.total, ...funnel },
      click_to_attribution_pct: conv,
      rewards: { issued_count: rewardSum.cnt, total_amount: Math.round(Number(rewardSum.total)) },
      top_referrers: top,
      ltv: { referred: Math.round(Number(ltv.referred_ltv)), average: Math.round(Number(ltv.avg_ltv)) },
      cac: rewardSum.cnt ? Math.round(Number(rewardSum.total) / rewardSum.cnt) : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MLM-дерево клієнта (хто кого привів, 2 рівні вниз)
router.get('/tree/:client_id', async (req, res) => {
  try {
    const id = parseInt(req.params.client_id, 10);
    const l1 = await q(`SELECT r.referee_id, c.name FROM referrals r LEFT JOIN clients c ON c.id=r.referee_id WHERE r.referrer_id=$1 AND r.referee_id IS NOT NULL`, [id]);
    const tree = [];
    for (const a of l1) {
      const l2 = await q(`SELECT r.referee_id, c.name FROM referrals r LEFT JOIN clients c ON c.id=r.referee_id WHERE r.referrer_id=$1 AND r.referee_id IS NOT NULL`, [a.referee_id]);
      tree.push({ client_id: a.referee_id, name: a.name, invited: l2.map(x => ({ client_id: x.referee_id, name: x.name })) });
    }
    res.json({ client_id: id, level1: tree, total_l1: tree.length, total_l2: tree.reduce((s, x) => s + x.invited.length, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Деталь реферала + винагороди
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await q(
      `SELECT r.*, rr.name AS referrer_name, re.name AS referee_name, rc.code
         FROM referrals r LEFT JOIN clients rr ON rr.id=r.referrer_id
         LEFT JOIN clients re ON re.id=r.referee_id
         LEFT JOIN referral_codes rc ON rc.id=r.referral_code_id WHERE r.id=$1`, [id]);
    if (!r.length) return res.status(404).json({ error: 'не знайдено' });
    const rewards = await q(`SELECT * FROM referral_rewards WHERE referral_id=$1 ORDER BY id`, [id]);
    res.json({ ...r[0], rewards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
