/* routes/gift-certificates.js — SLS-08 Подарункові сертифікати.
   Випуск, перевірка (для каси), використання (повне/часткове), повернення,
   анулювання, аналітика. Прагматична версія: штучний випуск без серій.
   Доступ: GET = cashbox.read, мутації = cashbox.write (касова функція). */
const express = require('express');
const crypto = require('crypto');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { recordCashIn, recordCashOut } = require('../lib/cash-ledger');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'cashbox.read' : 'cashbox.write';
  return requirePerm(perm)(req, res, next);
});

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// GC-XXXX-XXXX (без 0/O/1/I щоб не плутати)
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const blk = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return `GC-${blk()}-${blk()}`;
}
// Ліниве протермінування: якщо строк минув — позначити expired
async function refreshExpiry(gc) {
  if (gc && ['active', 'partially_used'].includes(gc.status) && gc.valid_until && String(gc.valid_until).slice(0, 10) < kyivToday()) {
    await pool.query(`UPDATE gift_certificates SET status='expired', updated_at=NOW() WHERE id=$1`, [gc.id]);
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,notes) VALUES ($1,'expiry',$2,$2,'auto-expiry')`, [gc.id, gc.remaining_amount]);
    gc.status = 'expired';
  }
  return gc;
}

// Вставити сертифікат з унікальним кодом (до 5 спроб на колізію коду).
async function insertCertificate(fields) {
  const cols = Object.keys(fields);
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    const all = { code, ...fields };
    const keys = Object.keys(all);
    const ph = keys.map((_, idx) => `$${idx + 1}`);
    try {
      const r = await pool.query(
        `INSERT INTO gift_certificates (${keys.join(',')}) VALUES (${ph.join(',')}) RETURNING *`,
        keys.map(k => all[k]));
      return r.rows[0];
    } catch (e) { if (!/unique/i.test(e.message) || i === 4) throw e; }
  }
}
// QR через зовнішній генератор (INF-02 File Storage поки не підключено — даємо URL).
function qrUrlFor(code) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(code)}`;
}

// ── POST / — випустити сертифікат (штучно) ──
router.post('/', async (req, res) => {
  try {
    const { type, service_id, amount, buyer_name, buyer_phone, buyer_client_id, recipient_name, recipient_phone, recipient_email, recipient_client_id, valid_days, series_id, service_restriction, deferred_activation, notes } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    if (amt > 1000000) return res.status(400).json({ error: 'amount too large (max 1 000 000)' });
    const days = Number(valid_days) > 0 ? Number(valid_days) : 365;
    const validUntil = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    // deferred_activation=true → статус 'issued', активується при першому використанні.
    const status = deferred_activation ? 'issued' : 'active';
    const gc = await insertCertificate({
      type: type === 'service' ? 'service' : 'nominal',
      service_id: service_id || null,
      original_amount: amt,
      remaining_amount: amt,
      status,
      series_id: series_id || null,
      buyer_name: buyer_name || null,
      buyer_phone: buyer_phone || null,
      buyer_client_id: buyer_client_id || null,
      recipient_name: recipient_name || null,
      recipient_phone: recipient_phone || null,
      recipient_email: recipient_email || null,
      recipient_client_id: recipient_client_id || null,
      service_restriction: Array.isArray(service_restriction) && service_restriction.length ? service_restriction : null,
      valid_until: validUntil,
      activated_at: deferred_activation ? null : new Date(),
      sold_by: req.user?.display_name || null,
      notes: notes || null,
    });
    gc.qr_url = qrUrlFor(gc.code);
    await pool.query(`UPDATE gift_certificates SET qr_url=$1 WHERE id=$2`, [gc.qr_url, gc.id]);
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'issue',$2,$2,$3,'випуск')`, [gc.id, amt, req.user?.display_name || null]);
    // деньги в кассу/ДДС: продажа сертификата (аудит 22.06 #12). Идемпотентно по ext_ref.
    await recordCashIn({ category: 'sale_certificate', amount: amt, method: req.body?.method || 'cash', ref_type: 'gift_certificate', ref_id: gc.id, description: `Продаж сертифіката ${gc.code}`, ext_ref: `gc:issue:${gc.id}` }).catch(e => console.error('cash-ledger gc:', e.message));
    logAction({ user: req.user, action: 'gc.issue', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { code: gc.code, amount: amt } }).catch(() => {});
    res.json({ ok: true, certificate: gc });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════════════════════ СЕРІЇ (08.01) ════════════════════════════════════
// ── POST /series — створити серію ──
router.post('/series', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const type = b.type === 'service' ? 'service' : 'nominal';
    if (type === 'nominal' && !(Number(b.nominal_amount) > 0)) return res.status(400).json({ error: 'nominal_amount required (> 0) для nominal' });
    if (type === 'service' && !b.service_id) return res.status(400).json({ error: 'service_id required для service' });
    const sr = Array.isArray(b.service_restriction) && b.service_restriction.length ? b.service_restriction : null;
    const row = (await pool.query(
      `INSERT INTO gift_certificate_series (name,type,nominal_amount,service_id,valid_days,design_template_id,service_restriction,quantity,active,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,TRUE),$10) RETURNING *`,
      [b.name, type, type === 'nominal' ? Number(b.nominal_amount) : null, b.service_id || null,
       Number(b.valid_days) > 0 ? Number(b.valid_days) : 365, b.design_template_id || null, sr, 0, b.active, b.notes || null]
    )).rows[0];
    logAction({ user: req.user, action: 'gc.series.create', entity: 'gift_certificate_series', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, series: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /series — список серій ──
router.get('/series', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
             (SELECT COUNT(*) FROM gift_certificates g WHERE g.series_id=s.id)::int AS issued_count,
             (SELECT COALESCE(SUM(g.original_amount - g.remaining_amount),0) FROM gift_certificates g WHERE g.series_id=s.id)::numeric AS used_amount
        FROM gift_certificate_series s ORDER BY s.created_at DESC`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /series/:id/issue — випустити тираж сертифікатів із серії ──
router.post('/series/:id/issue', async (req, res) => {
  try {
    const s = (await pool.query(`SELECT * FROM gift_certificate_series WHERE id=$1`, [+req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'series not found' });
    if (!s.active) return res.status(409).json({ error: 'series inactive' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 500);
    const amt = Number(s.nominal_amount) || Number(req.body?.amount);
    if (s.type === 'nominal' && !(amt > 0)) return res.status(400).json({ error: 'amount required для серії без nominal_amount' });
    const validUntil = new Date(Date.now() + (s.valid_days || 365) * 86400000).toISOString().slice(0, 10);
    const issued = [];
    for (let i = 0; i < count; i++) {
      const gc = await insertCertificate({
        type: s.type, service_id: s.service_id || null,
        original_amount: amt || 0, remaining_amount: amt || 0,
        status: 'issued', series_id: s.id,
        service_restriction: s.service_restriction || null,
        valid_until: validUntil, sold_by: req.user?.display_name || null,
      });
      gc.qr_url = qrUrlFor(gc.code);
      await pool.query(`UPDATE gift_certificates SET qr_url=$1 WHERE id=$2`, [gc.qr_url, gc.id]);
      await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'issue',$2,$2,$3,'тираж серії')`, [gc.id, amt || 0, req.user?.display_name || null]);
      issued.push(gc);
    }
    await pool.query(`UPDATE gift_certificate_series SET quantity=quantity+$1, updated_at=NOW() WHERE id=$2`, [count, s.id]);
    logAction({ user: req.user, action: 'gc.series.issue', entity: 'gift_certificate_series', entity_id: s.id, ip: req.ip, meta: { count } }).catch(() => {});
    res.json({ ok: true, issued_count: issued.length, certificates: issued });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════════════════════ ДИЗАЙН-ШАБЛОНИ (08.04) ════════════════════════════
// ── GET /templates — список шаблонів ──
router.get('/templates', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gc_design_templates WHERE active=TRUE ORDER BY id`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /templates — створити шаблон ──
router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.html_template) return res.status(400).json({ error: 'name та html_template обовʼязкові' });
    const row = (await pool.query(
      `INSERT INTO gc_design_templates (name,type,html_template,css,preview_url,active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE)) RETURNING *`,
      [b.name, ['email', 'print', 'telegram'].includes(b.type) ? b.type : 'email', b.html_template, b.css || null, b.preview_url || null, b.active]
    )).rows[0];
    logAction({ user: req.user, action: 'gc.template.create', entity: 'gc_design_template', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, template: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /:id/render — згенерований HTML сертифіката (предпросмотр/відправка) ──
router.get('/:id/render', async (req, res) => {
  try {
    const gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    let tpl = null;
    if (req.query.template_id) tpl = (await pool.query(`SELECT * FROM gc_design_templates WHERE id=$1`, [+req.query.template_id])).rows[0];
    if (!tpl && gc.series_id) {
      const s = (await pool.query(`SELECT design_template_id FROM gift_certificate_series WHERE id=$1`, [gc.series_id])).rows[0];
      if (s?.design_template_id) tpl = (await pool.query(`SELECT * FROM gc_design_templates WHERE id=$1`, [s.design_template_id])).rows[0];
    }
    if (!tpl) tpl = (await pool.query(`SELECT * FROM gc_design_templates WHERE active=TRUE ORDER BY id LIMIT 1`)).rows[0];
    if (!tpl) return res.status(404).json({ error: 'no template' });
    const fill = (s) => String(s || '')
      .replace(/\{номінал\}|\{номинал\}/g, Number(gc.remaining_amount))
      .replace(/\{код\}/g, gc.code)
      .replace(/\{QR\}/g, gc.qr_url ? `<img src="${gc.qr_url}" alt="QR">` : '')
      .replace(/\{дата_до\}/g, String(gc.valid_until).slice(0, 10))
      .replace(/\{имя_получателя\}|\{ім'я_отримувача\}/g, gc.recipient_name || '')
      .replace(/\{имя_покупателя\}|\{ім'я_покупця\}/g, gc.buyer_name || '');
    const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tpl.css || ''}</style></head><body>${fill(tpl.html_template)}</body></html>`;
    res.type('html').send(html);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════════════════════ ПРОДАЖ І АКТИВАЦІЯ (08.02) ════════════════════════
// ── POST /:id/sell — продати випущений сертифікат (buyer ≠ recipient) ──
router.post('/:id/sell', async (req, res) => {
  try {
    const b = req.body || {};
    const gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    // Продати можна лише випущений (issued) сертифікат. active/partially_used вже
    // продані — повторний /sell перезаписував покупця і дублював транзакцію 'sale'.
    if (gc.status !== 'issued') return res.status(409).json({ error: 'not-sellable', status: gc.status, message: 'Продати можна лише сертифікат у статусі issued' });
    // активувати при продажу (за замовч.), або лишити issued при deferred_activation.
    const deferred = b.deferred_activation === true;
    const newStatus = deferred ? 'issued' : 'active';
    const upd = (await pool.query(
      `UPDATE gift_certificates SET status=$1, sold_at=NOW(),
         activated_at=CASE WHEN $1='active' AND activated_at IS NULL THEN NOW() ELSE activated_at END,
         buyer_client_id=COALESCE($2,buyer_client_id), buyer_name=COALESCE($3,buyer_name), buyer_phone=COALESCE($4,buyer_phone),
         recipient_client_id=COALESCE($5,recipient_client_id), recipient_name=COALESCE($6,recipient_name),
         recipient_phone=COALESCE($7,recipient_phone), recipient_email=COALESCE($8,recipient_email),
         sold_by=COALESCE($9,sold_by), updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [newStatus, b.buyer_client_id || null, b.buyer_name || null, b.buyer_phone || null,
       b.recipient_client_id || null, b.recipient_name || null, b.recipient_phone || null, b.recipient_email || null,
       req.user?.display_name || null, gc.id]
    )).rows[0];
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'sale',$2,$2,$3,$4)`,
      [gc.id, gc.original_amount, req.user?.display_name || null, deferred ? 'продаж (відкладена активація)' : 'продаж']);
    // Гроші в касу (аудит 2026-07-02): тиражні сертифікати (/series/:id/issue) каси не
    // торкались — для них оплата = момент /sell. Звичайний випуск (POST /) касу вже
    // записав (ext_ref gc:issue:<id>) — тоді тут НЕ дублюємо. Ідемпотентно: повторний
    // /sell не задвоїть завдяки ext_ref gc:sell:<id> (та й status='issued' вже не пройде).
    try {
      const issueOp = (await pool.query(`SELECT 1 FROM cash_operations WHERE ext_ref=$1 LIMIT 1`, [`gc:issue:${gc.id}`])).rows[0];
      if (!issueOp) {
        await recordCashIn({ category: 'sale_certificate', amount: Number(gc.original_amount),
          method: b.payment_method || b.method || 'cash', ref_type: 'gift_certificate', ref_id: gc.id,
          description: `Продаж сертифіката ${gc.code}`, ext_ref: `gc:sell:${gc.id}` });
      }
    } catch (e) { console.error('cash-ledger gc sell:', e.message); }
    logAction({ user: req.user, action: 'gc.sell', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { payment_method: b.payment_method } }).catch(() => {});
    res.json({ ok: true, certificate: upd });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /:id/activate — активувати (для відкладеної активації) ──
router.post('/:id/activate', async (req, res) => {
  try {
    let gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    gc = await refreshExpiry(gc);
    if (gc.status === 'active' || gc.status === 'partially_used') return res.json({ ok: true, certificate: gc, already: true });
    if (!['issued', 'sold'].includes(gc.status)) return res.status(409).json({ error: 'not-activatable', status: gc.status });
    const upd = (await pool.query(
      `UPDATE gift_certificates SET status='active', activated_at=COALESCE(activated_at,NOW()), valid_from=COALESCE(valid_from,CURRENT_DATE), updated_at=NOW() WHERE id=$1 RETURNING *`, [gc.id])).rows[0];
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'activation',$2,$2,$3,'активація')`, [gc.id, gc.remaining_amount, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'gc.activate', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, certificate: upd });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /:id/send — відправити електронний сертифікат (фіксуємо канал/час) ──
router.post('/:id/send', async (req, res) => {
  try {
    const channel = req.body?.channel;
    if (!['telegram', 'email', 'sms'].includes(channel)) return res.status(400).json({ error: "channel: telegram|email|sms" });
    const gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    // Фактична доставка — через COM-01 Notification Hub (поза модулем). Тут лише облік факту.
    const upd = (await pool.query(`UPDATE gift_certificates SET sent_at=NOW(), sent_channel=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [channel, gc.id])).rows[0];
    logAction({ user: req.user, action: 'gc.send', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { channel } }).catch(() => {});
    res.json({ ok: true, certificate: upd, channel, render_url: `/api/gift-certificates/${gc.id}/render` });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET / — список ──
router.get('/', async (req, res) => {
  try {
    const params = [], cond = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`status=$${params.length}`); }
    if (req.query.series_id) { params.push(+req.query.series_id); cond.push(`series_id=$${params.length}`); }
    if (req.query.code) { params.push('%' + req.query.code.toUpperCase() + '%'); cond.push(`code ILIKE $${params.length}`); }
    if (req.query.recipient_phone) { params.push('%' + req.query.recipient_phone + '%'); cond.push(`recipient_phone ILIKE $${params.length}`); }
    if (req.query.phone) { params.push('%' + req.query.phone + '%'); cond.push(`(buyer_phone ILIKE $${params.length} OR recipient_phone ILIKE $${params.length})`); }
    if (req.query.from) { params.push(req.query.from + ' 00:00:00+03'); cond.push(`created_at >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to + ' 23:59:59+03'); cond.push(`created_at <= $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(+req.query.limit || 100, 500);
    const off = Math.max(+req.query.offset || 0, 0);
    const r = await pool.query(`SELECT * FROM gift_certificates ${where} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`, params);
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM gift_certificates ${where}`, params)).rows[0].n;
    res.json({ items: r.rows, count: r.rows.length, total });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /analytics — аналітика (08.05) ──
router.get('/analytics', async (req, res) => {
  try {
    const from = (req.query.from || '2000-01-01') + ' 00:00:00+03';
    const to = (req.query.to || kyivToday()) + ' 23:59:59+03';
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at BETWEEN $1 AND $2)::int AS sold_count,
        COALESCE(SUM(original_amount) FILTER (WHERE created_at BETWEEN $1 AND $2),0)::numeric AS sold_amount,
        COALESCE(SUM(original_amount - remaining_amount),0)::numeric AS used_amount,
        COALESCE(SUM(remaining_amount) FILTER (WHERE status='expired'),0)::numeric AS expired_amount,
        COALESCE(SUM(remaining_amount) FILTER (WHERE status IN ('active','partially_used','issued','sold')),0)::numeric AS outstanding_amount,
        COUNT(*) FILTER (WHERE status='expired')::int AS expired_count,
        COUNT(*) FILTER (WHERE status='fully_used')::int AS fully_used_count,
        COUNT(*) FILTER (WHERE status IN ('active','partially_used'))::int AS active_count
      FROM gift_certificates`, [from, to]);
    const base = r.rows[0];
    // Середній строк використання від активації до першого usage (днів).
    const avg = (await pool.query(`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_use - gc.activated_at)) / 86400),0)::numeric AS avg_days
        FROM gift_certificates gc
        JOIN LATERAL (SELECT MIN(created_at) AS first_use FROM gift_certificate_transactions t
                       WHERE t.gc_id=gc.id AND t.type='usage') u ON TRUE
       WHERE gc.activated_at IS NOT NULL AND u.first_use IS NOT NULL`)).rows[0];
    // Конверсія: % сертифікатів, де отримувач став новим клієнтом (perший візит ПІСЛЯ продажу).
    const conv = (await pool.query(`
      WITH sold AS (
        SELECT id, recipient_client_id, COALESCE(sold_at, created_at) AS sd
          FROM gift_certificates
         WHERE recipient_client_id IS NOT NULL
           AND COALESCE(sold_at, created_at) BETWEEN $1 AND $2)
      SELECT COUNT(*)::int AS sold_with_recipient,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM appointments a
                WHERE a.client_id = sold.recipient_client_id
                  AND a.created_at >= sold.sd
                  AND NOT EXISTS (SELECT 1 FROM appointments a2
                                   WHERE a2.client_id = sold.recipient_client_id
                                     AND a2.created_at < sold.sd)))::int AS new_clients_from_gc
        FROM sold`, [from, to])).rows[0];
    const soldWithRecipient = Number(conv.sold_with_recipient) || 0;
    const newClients = Number(conv.new_clients_from_gc) || 0;
    res.json({
      period: { from: req.query.from || '2000-01-01', to: req.query.to || kyivToday() },
      sold_count: Number(base.sold_count),
      sold_amount: Number(base.sold_amount),
      used_amount: Number(base.used_amount),
      expired_amount: Number(base.expired_amount),
      expired_count: Number(base.expired_count),
      fully_used_count: Number(base.fully_used_count),
      active_count: Number(base.active_count),
      outstanding_amount: Number(base.outstanding_amount),   // поточний "борг" салону
      burned_revenue: Number(base.expired_amount),           // "згорілі" = дохід
      avg_days_to_use: +Number(avg.avg_days).toFixed(1),
      new_clients_from_gc: newClients,
      conversion_rate: soldWithRecipient ? +(newClients / soldWithRecipient * 100).toFixed(1) : 0,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /check/:code — перевірка для каси ──
router.get('/check/:code', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gift_certificates WHERE code=$1`, [req.params.code.toUpperCase()]);
    let gc = r.rows[0];
    if (!gc) return res.json({ valid: false, reason: 'not-found' });
    gc = await refreshExpiry(gc);
    const usable = ['active', 'partially_used'].includes(gc.status) && Number(gc.remaining_amount) > 0;
    // issued/sold з відкладеною активацією — валідні (активуються при використанні).
    const activatable = ['issued', 'sold'].includes(gc.status) && Number(gc.remaining_amount) > 0;
    const valid = usable || activatable;
    res.json({ valid, status: gc.status, id: gc.id, code: gc.code, type: gc.type, service_id: gc.service_id,
      remaining_amount: Number(gc.remaining_amount), original_amount: Number(gc.original_amount), valid_until: gc.valid_until,
      needs_activation: activatable,
      restrictions: { service_restriction: gc.service_restriction || null, type: gc.type, service_id: gc.service_id || null },
      reason: valid ? null : (gc.status === 'expired' ? 'expired' : gc.status === 'cancelled' ? 'cancelled' : gc.status === 'fully_used' ? 'no-balance' : 'inactive') });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /:id — деталі + транзакції ──
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    const tx = await pool.query(`SELECT * FROM gift_certificate_transactions WHERE gc_id=$1 ORDER BY created_at`, [+req.params.id]);
    res.json({ certificate: r.rows[0], transactions: tx.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /:id/use — використати (повне/часткове) ──
router.post('/:id/use', async (req, res) => {
  try {
    const amt = Number(req.body?.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    let gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    gc = await refreshExpiry(gc);
    // Відкладена активація: перше використання активує сертифікат.
    if (['issued', 'sold'].includes(gc.status) && Number(gc.remaining_amount) > 0 && gc.valid_until && String(gc.valid_until).slice(0, 10) >= kyivToday()) {
      await pool.query(`UPDATE gift_certificates SET status='active', activated_at=COALESCE(activated_at,NOW()), valid_from=COALESCE(valid_from,CURRENT_DATE), updated_at=NOW() WHERE id=$1`, [gc.id]);
      await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'activation',$2,$2,$3,'авто-активація при використанні')`, [gc.id, gc.remaining_amount, req.user?.display_name || null]);
      gc.status = 'active';
    }
    if (!['active', 'partially_used'].includes(gc.status)) return res.status(409).json({ error: 'not-usable', status: gc.status });
    // Цільовий сертифікат / обмеження за послугами: перевірити service_id.
    const restr = gc.service_restriction;
    if (gc.type === 'service' && gc.service_id) {
      if (req.body?.service_id && Number(req.body.service_id) !== Number(gc.service_id))
        return res.status(409).json({ error: 'service-mismatch', allowed_service_id: gc.service_id });
    } else if (Array.isArray(restr) && restr.length && req.body?.service_id) {
      if (!restr.map(Number).includes(Number(req.body.service_id)))
        return res.status(409).json({ error: 'service-not-allowed', allowed: restr });
    }
    if (amt > Number(gc.remaining_amount)) return res.status(409).json({ error: 'insufficient-balance', remaining: Number(gc.remaining_amount) });
    // Атомарне списання: умовний UPDATE закриває lost update при гонці двох /use
    // (раніше read-modify-write перезаписував баланс — сертифікат «дарував» гроші).
    // Списання + журнал usage — в одній транзакції, щоб не втратити слід операції.
    const client = await pool.connect();
    let updRow;
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const upd = await client.query(
        `UPDATE gift_certificates
            SET remaining_amount = remaining_amount - $1,
                status = CASE WHEN remaining_amount - $1 <= 0.001 THEN 'fully_used' ELSE 'partially_used' END,
                updated_at = NOW()
          WHERE id = $2 AND status IN ('active','partially_used') AND remaining_amount >= $1
          RETURNING *`, [amt, gc.id]);
      updRow = upd.rows[0];
      if (!updRow) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          `INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,appointment_id,order_id,performed_by,notes) VALUES ($1,'usage',$2,$3,$4,$5,$6,$7)`,
          [gc.id, amt, Number(updRow.remaining_amount), req.body?.appointment_id || null, req.body?.order_id || null, req.user?.display_name || null, req.body?.notes || null]);
        await client.query('COMMIT');
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    if (!updRow) {
      // програли гонку паралельному /use — залишку вже не вистачає
      const cur = (await pool.query(`SELECT remaining_amount, status FROM gift_certificates WHERE id=$1`, [gc.id])).rows[0];
      return res.status(409).json({ error: 'insufficient-balance', remaining: Number(cur?.remaining_amount ?? 0), status: cur?.status });
    }
    const balance = Number(updRow.remaining_amount);
    logAction({ user: req.user, action: 'gc.use', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { amount: amt, balance } }).catch(() => {});
    res.json({ ok: true, certificate: updRow, used: amt, balance });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /:id/refund — повернення коштів на сертифікат ──
// Повернення = відкат usage (послугу скасували, гроші вертаються НА сертифікат).
// Тому воно привʼязане до фактичних usage: не можна повернути більше, ніж
// реально списано (за мінусом уже повернутого), і не можна «оживити» expired.
// Каса не рухається: usage касу не чіпав, тож і сторно каси тут немає.
router.post('/:id/refund', async (req, res) => {
  try {
    const amt = Number(req.body?.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const gc = (await client.query(`SELECT * FROM gift_certificates WHERE id=$1 FOR UPDATE`, [+req.params.id])).rows[0];
      if (!gc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      if (gc.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'cancelled' }); }
      if (gc.status === 'expired') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'expired', message: 'Повернення на протермінований сертифікат заборонено' }); }
      const u = (await client.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE type='usage'),0)
              - COALESCE(SUM(amount) FILTER (WHERE type='refund'),0) AS net_used
           FROM gift_certificate_transactions WHERE gc_id=$1`, [gc.id])).rows[0];
      const refundable = Math.max(0, Number(u.net_used));
      if (amt > refundable + 0.001) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'refund-exceeds-usage', refundable, message: 'Не можна повернути більше, ніж фактично використано' });
      }
      const balance = Math.min(Number(gc.remaining_amount) + amt, Number(gc.original_amount));
      const newStatus = balance >= Number(gc.original_amount) ? 'active' : 'partially_used';
      const upd = await client.query(`UPDATE gift_certificates SET remaining_amount=$1, status=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [balance, newStatus, gc.id]);
      await client.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'refund',$2,$3,$4,$5)`,
        [gc.id, amt, balance, req.user?.display_name || null, req.body?.reason || null]);
      await client.query('COMMIT');
      result = { certificate: upd.rows[0], balance };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    logAction({ user: req.user, action: 'gc.refund', entity: 'gift_certificate', entity_id: +req.params.id, ip: req.ip, meta: { amount: amt } }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /:id/cancel — анулювати ──
router.post('/:id/cancel', async (req, res) => {
  const client = await pool.connect();
  try {
    // Блокер E1: раніше cancel читав сертифікат без FOR UPDATE і працював поза транзакцією —
    // гонка з погашенням/паралельним cancel брала стейл remaining_amount → невірне повернення
    // грошей. Тепер усе в одній транзакції з блокуванням рядка; сторно каси — тут же (db: client),
    // щоб при відкаті не лишалось «висячого» повернення. ext_ref 'gc:cancel:<id>' — ідемпотентність.
    await client.query('BEGIN'); await applyTenant(client);
    const gc = (await client.query(`SELECT * FROM gift_certificates WHERE id=$1 FOR UPDATE`, [+req.params.id])).rows[0];
    if (!gc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (gc.status === 'cancelled') { await client.query('ROLLBACK'); return res.json({ ok: true, certificate: gc }); }
    const upd = await client.query(`UPDATE gift_certificates SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`, [gc.id]);
    await client.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'cancellation',$2,$2,$3,$4)`,
      [gc.id, gc.remaining_amount, req.user?.display_name || null, req.body?.reason || 'анульовано']);
    const issueOp = (await client.query(`SELECT method, amount FROM cash_operations WHERE ext_ref IN ($1,$2) LIMIT 1`, [`gc:issue:${gc.id}`, `gc:sell:${gc.id}`])).rows[0];
    const back = Math.min(Number(gc.remaining_amount) || 0, issueOp ? Number(issueOp.amount) : 0);
    if (issueOp && back > 0) {
      await recordCashOut({ category: 'refund', amount: back, method: issueOp.method,
        ref_type: 'gift_certificate', ref_id: gc.id,
        description: `Повернення за анульований сертифікат ${gc.code}`, ext_ref: `gc:cancel:${gc.id}`, db: client });
    }
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'gc.cancel', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, certificate: upd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

module.exports = router;
