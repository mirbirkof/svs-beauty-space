/* routes/referral-marketing.js — MKT-05 Реферальний маркетинг.
   Маркетингова надбудова над FIN-02: лендинги реферальної програми, промоматеріали,
   гейміфікація (лідерборд + рівні bronze/silver/gold/platinum), аналітика воронки.
   Нарахування винагород лишається у FIN-02 (referral.js) — тут лише маркетинговий шар.
   Дані кліків/конверсій беруться з FIN-02 (referral_codes / referral_clicks).
   Доступ: публічний лендинг — без авторизації; решта — referral_mkt.* (мапиться на marketing-права). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function levelFor(converted) {
  if (converted >= 6) return 'gold';
  if (converted >= 3) return 'silver';
  if (converted >= 1) return 'bronze';
  return 'bronze';
}

// ─── ПУБЛІЧНИЙ ЛЕНДИНГ (без авторизації) ─────────────────────────────────────
// GET /api/referral-marketing/landing/:slug → HTML сторінка реферальної програми
router.get('/landing/:slug', async (req, res) => {
  try {
    const rows = await q(
      `SELECT * FROM referral_marketing_programs WHERE landing_slug=$1 AND active=TRUE LIMIT 1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).type('html').send('<h1>Програму не знайдено</h1>');
    const p = rows[0];
    if (p.landing_html) return res.type('html').send(p.landing_html);

    // ref-код реферера з query (?ref=SVS-XXXX) — підставляємо у форму
    const refCode = String(req.query.ref || '').trim();
    const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.hero_title || p.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;line-height:1.5}
.wrap{max-width:560px;margin:0 auto;padding:32px 20px}
.hero{text-align:center;padding:40px 0}.hero h1{font-size:28px;margin-bottom:12px}.hero p{color:#9aa0a6;font-size:17px}
.cards{display:grid;gap:14px;margin:28px 0}
.card{background:#1a1d24;border:1px solid #2a2f3a;border-radius:14px;padding:18px}
.card h3{font-size:15px;color:#8ab4f8;margin-bottom:6px}.card p{color:#c5c8cc;font-size:15px}
.cta{display:block;width:100%;background:#8ab4f8;color:#0f1115;border:0;border-radius:12px;padding:16px;font-size:17px;font-weight:600;text-decoration:none;text-align:center;margin-top:8px;cursor:pointer}
.foot{text-align:center;color:#5f6368;font-size:13px;margin-top:24px}
</style></head><body><div class="wrap">
<div class="hero"><h1>${esc(p.hero_title || p.name)}</h1>
${p.hero_subtitle ? `<p>${esc(p.hero_subtitle)}</p>` : ''}</div>
<div class="cards">
<div class="card"><h3>Ти отримаєш</h3><p>${esc(p.referrer_reward_description || 'Винагороду за кожного запрошеного друга')}</p></div>
<div class="card"><h3>Друг отримає</h3><p>${esc(p.friend_reward_description || 'Знижку на перший візит')}</p></div>
</div>
<a class="cta" href="/?ref=${encodeURIComponent(refCode)}#booking">${esc(p.cta_text || 'Записатися зі знижкою')}</a>
<div class="foot">${refCode ? 'Код запрошення: ' + esc(refCode) : ''}</div>
</div></body></html>`;
    res.type('html').send(html);
  } catch (e) {
    console.error('[referral-marketing] landing:', e.message);
    res.status(500).type('html').send('<h1>Помилка</h1>');
  }
});

// ─── Далі — лише авторизовані (RBAC) ─────────────────────────────────────────
router.use((req, res, next) => {
  // analytics доступна manager-ам; решта мутацій — marketer/admin.
  let perm;
  if (req.method === 'GET') perm = 'reports.read';
  else perm = 'reports.finance';
  return requirePerm(perm)(req, res, next);
});

// ── ПРОГРАМА ──────────────────────────────────────────────────────────────────
// GET /program — поточна (перша активна або найновіша)
router.get('/program', async (_req, res) => {
  try {
    let rows = await q(`SELECT * FROM referral_marketing_programs ORDER BY active DESC, updated_at DESC LIMIT 1`);
    res.json(rows[0] || null);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /programs — список усіх
router.get('/programs', async (_req, res) => {
  try {
    res.json(await q(`SELECT * FROM referral_marketing_programs ORDER BY updated_at DESC`));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /program — створити
router.post('/program', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.landing_slug) return res.status(400).json({ error: 'name та landing_slug обовʼязкові' });
    const slug = String(b.landing_slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
    const row = (await q(
      `INSERT INTO referral_marketing_programs
         (branch_id,name,landing_slug,landing_html,referrer_reward_description,friend_reward_description,hero_title,hero_subtitle,cta_text,theme,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'Записатися зі знижкою'),COALESCE($10,'default'),COALESCE($11,TRUE))
       RETURNING *`,
      [b.branch_id || null, b.name, slug, b.landing_html || null, b.referrer_reward_description || null,
       b.friend_reward_description || null, b.hero_title || null, b.hero_subtitle || null, b.cta_text || null, b.theme || null, b.active]
    ))[0];
    await logAction({ user: req.user, action: 'refmkt.program.create', entity: 'referral_marketing_program', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'landing_slug вже зайнятий' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

// PUT /program/:id — оновити
router.put('/program/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const fields = ['branch_id','name','landing_slug','landing_html','referrer_reward_description',
      'friend_reward_description','hero_title','hero_subtitle','cta_text','theme','active'];
    const set = [], vals = [];
    for (const f of fields) {
      if (b[f] !== undefined) {
        let v = b[f];
        if (f === 'landing_slug') v = String(v).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
        set.push(`${f}=$${vals.length + 1}`); vals.push(v);
      }
    }
    if (!set.length) return res.status(400).json({ error: 'нема полів для оновлення' });
    set.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    const row = (await q(
      `UPDATE referral_marketing_programs SET ${set.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'refmkt.program.update', entity: 'referral_marketing_program', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'landing_slug вже зайнятий' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

// DELETE /program/:id
router.delete('/program/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM referral_marketing_programs WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'refmkt.program.delete', entity: 'referral_marketing_program', entity_id: row.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── ПРОМОМАТЕРІАЛИ ───────────────────────────────────────────────────────────
// GET /materials?program_id=&type=
router.get('/materials', async (req, res) => {
  try {
    const where = [], vals = [];
    if (req.query.program_id) { vals.push(req.query.program_id); where.push(`program_id=$${vals.length}`); }
    if (req.query.type) { vals.push(req.query.type); where.push(`type=$${vals.length}`); }
    const sql = `SELECT * FROM referral_marketing_materials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    res.json(await q(sql, vals));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /materials
router.post('/materials', async (req, res) => {
  try {
    const b = req.body || {};
    const types = ['text', 'banner', 'story', 'flyer', 'card'];
    if (!types.includes(b.type)) return res.status(400).json({ error: 'type: ' + types.join('|') });
    const row = (await q(
      `INSERT INTO referral_marketing_materials (program_id,type,title,content,image_url,active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE)) RETURNING *`,
      [b.program_id || null, b.type, b.title || null, b.content || null, b.image_url || null, b.active]
    ))[0];
    await logAction({ user: req.user, action: 'refmkt.material.create', entity: 'referral_marketing_material', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PUT /materials/:id
router.put('/materials/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const set = [], vals = [];
    for (const f of ['program_id', 'type', 'title', 'content', 'image_url', 'active']) {
      if (b[f] !== undefined) { set.push(`${f}=$${vals.length + 1}`); vals.push(b[f]); }
    }
    if (!set.length) return res.status(400).json({ error: 'нема полів' });
    set.push('updated_at=NOW()'); vals.push(req.params.id);
    const row = (await q(`UPDATE referral_marketing_materials SET ${set.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// DELETE /materials/:id
router.delete('/materials/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM referral_marketing_materials WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /materials/:id/share?client_id= — персоналізований текст для шарингу
router.get('/materials/:id/share', async (req, res) => {
  try {
    const m = (await q(`SELECT * FROM referral_marketing_materials WHERE id=$1`, [req.params.id]))[0];
    if (!m) return res.status(404).json({ error: 'not found' });
    let name = '', code = '';
    if (req.query.client_id) {
      const c = (await q(`SELECT name FROM clients WHERE id=$1`, [req.query.client_id]))[0];
      name = c ? c.name : '';
      const rc = (await q(`SELECT code FROM referral_codes WHERE client_id=$1 AND is_active=TRUE ORDER BY id LIMIT 1`, [req.query.client_id]))[0];
      code = rc ? rc.code : '';
    }
    const filled = String(m.content || '').replace(/\{name\}/g, name).replace(/\{code\}/g, code).replace(/\{discount\}/g, '');
    res.json({ id: m.id, type: m.type, title: m.title, content: filled, image_url: m.image_url, code });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── ЛІДЕРБОРД (живий розрахунок з даних FIN-02) ─────────────────────────────
// GET /leaderboard?period=2026-06&limit=10
router.get('/leaderboard', async (req, res) => {
  try {
    const period = String(req.query.period || new Date().toISOString().slice(0, 7));
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const rows = await q(
      `SELECT rc.client_id,
              COALESCE(cl.name, 'Клієнт #' || rc.client_id) AS client_name,
              COUNT(DISTINCT cli.id)                                  AS referrals_count,
              COUNT(DISTINCT cli.id) FILTER (WHERE cli.converted)     AS referrals_converted,
              COALESCE(SUM(rw.reward_amount) FILTER (WHERE rw.recipient_role='referrer'),0) AS total_reward
         FROM referral_codes rc
         LEFT JOIN clients cl ON cl.id = rc.client_id
         LEFT JOIN referral_clicks cli ON cli.referral_code_id = rc.id
              AND to_char(cli.created_at,'YYYY-MM') = $1
         LEFT JOIN referral_rewards rw ON rw.recipient_id = rc.client_id
              AND to_char(rw.created_at,'YYYY-MM') = $1
        GROUP BY rc.client_id, cl.name
       HAVING COUNT(DISTINCT cli.id) > 0
        ORDER BY referrals_converted DESC, referrals_count DESC, total_reward DESC
        LIMIT $2`,
      [period, limit]
    );
    const board = rows.map((r, i) => ({
      rank: i + 1,
      client_id: r.client_id,
      client_name: r.client_name,
      referrals_count: Number(r.referrals_count),
      referrals_converted: Number(r.referrals_converted),
      total_reward: Number(r.total_reward),
      level: levelFor(Number(r.referrals_converted)),
    }));
    res.json({ period, leaderboard: board });
  } catch (e) { console.error('[refmkt] leaderboard:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /leaderboard/rebuild?period= — зробити снапшот у таблицю
router.post('/leaderboard/rebuild', async (req, res) => {
  try {
    const period = String(req.body?.period || new Date().toISOString().slice(0, 7));
    const rows = await q(
      `SELECT rc.client_id,
              COUNT(DISTINCT cli.id)                              AS rc_count,
              COUNT(DISTINCT cli.id) FILTER (WHERE cli.converted) AS rc_conv,
              COALESCE(SUM(rw.reward_amount) FILTER (WHERE rw.recipient_role='referrer'),0) AS total_reward
         FROM referral_codes rc
         LEFT JOIN referral_clicks cli ON cli.referral_code_id = rc.id AND to_char(cli.created_at,'YYYY-MM') = $1
         LEFT JOIN referral_rewards rw ON rw.recipient_id = rc.client_id AND to_char(rw.created_at,'YYYY-MM') = $1
        GROUP BY rc.client_id
       HAVING COUNT(DISTINCT cli.id) > 0
        ORDER BY rc_conv DESC, rc_count DESC`,
      [period]
    );
    let rank = 0;
    for (const r of rows) {
      rank++;
      await q(
        `INSERT INTO referral_marketing_leaderboard
           (client_id,period,referrals_count,referrals_converted,total_reward,rank,level)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,client_id,period) DO UPDATE SET
           referrals_count=EXCLUDED.referrals_count, referrals_converted=EXCLUDED.referrals_converted,
           total_reward=EXCLUDED.total_reward, rank=EXCLUDED.rank, level=EXCLUDED.level, updated_at=NOW()`,
        [r.client_id, period, Number(r.rc_count), Number(r.rc_conv), Number(r.total_reward), rank, levelFor(Number(r.rc_conv))]
      );
    }
    await logAction({ user: req.user, action: 'refmkt.leaderboard.rebuild', entity: 'referral_marketing_leaderboard', entity_id: null, ip: req.ip });
    res.json({ ok: true, period, ranked: rank });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── АНАЛІТИКА ────────────────────────────────────────────────────────────────
// GET /analytics?from=&to=
router.get('/analytics', async (req, res) => {
  try {
    const from = req.query.from || '2000-01-01';
    const to = req.query.to || '2999-12-31';
    // Воронка: кліки → конверсії (з referral_clicks), реферери та реферали (referral_codes)
    const funnel = (await q(
      `SELECT COUNT(*)::int AS clicks,
              COUNT(*) FILTER (WHERE converted)::int AS conversions,
              COUNT(DISTINCT referral_code_id)::int AS active_referrers
         FROM referral_clicks
        WHERE created_at::date BETWEEN $1 AND $2`,
      [from, to]
    ))[0];
    const refStats = (await q(
      `SELECT COUNT(DISTINCT rc.client_id)::int AS total_referrers,
              COALESCE(SUM(rc.total_referrals),0)::int AS total_referrals
         FROM referral_codes rc`
    ))[0];
    // Винагороди (CAC через рефералів = сума виданих винагород / число залучених)
    const rewards = (await q(
      `SELECT COALESCE(SUM(reward_amount),0)::numeric AS total_reward,
              COUNT(*) FILTER (WHERE recipient_role='referee')::int AS acquired
         FROM referral_rewards
        WHERE created_at::date BETWEEN $1 AND $2`,
      [from, to]
    ))[0];
    const acquired = Number(rewards.acquired) || 0;
    const totalReferrers = Number(refStats.total_referrers) || 0;
    const totalReferrals = Number(refStats.total_referrals) || 0;
    const conversions = Number(funnel.conversions) || 0;
    const clicks = Number(funnel.clicks) || 0;
    res.json({
      period: { from, to },
      funnel: {
        clicks,
        conversions,
        conversion_rate: clicks ? +(conversions / clicks * 100).toFixed(1) : 0,
        active_referrers: Number(funnel.active_referrers) || 0,
      },
      viral_coefficient: totalReferrers ? +(totalReferrals / totalReferrers).toFixed(2) : 0,
      cac_referral: acquired ? +(Number(rewards.total_reward) / acquired).toFixed(2) : 0,
      total_reward_paid: Number(rewards.total_reward),
      acquired_via_referral: acquired,
      total_referrers: totalReferrers,
      total_referrals: totalReferrals,
    });
  } catch (e) { console.error('[refmkt] analytics:', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
