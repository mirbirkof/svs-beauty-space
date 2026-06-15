/* routes/gift-certificates.js — SLS-08 Подарункові сертифікати.
   Випуск, перевірка (для каси), використання (повне/часткове), повернення,
   анулювання, аналітика. Прагматична версія: штучний випуск без серій.
   Доступ: GET = cashbox.read, мутації = cashbox.write (касова функція). */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

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

// ── POST / — випустити сертифікат ──
router.post('/', async (req, res) => {
  try {
    const { type, service_id, amount, buyer_name, buyer_phone, recipient_name, recipient_phone, valid_days, notes } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    const days = Number(valid_days) > 0 ? Number(valid_days) : 365;
    const validUntil = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    // унікальний код (до 5 спроб)
    let code, ins;
    for (let i = 0; i < 5; i++) {
      code = genCode();
      try {
        ins = await pool.query(
          `INSERT INTO gift_certificates (code,type,service_id,original_amount,remaining_amount,buyer_name,buyer_phone,recipient_name,recipient_phone,valid_until,sold_by,notes)
           VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [code, type === 'service' ? 'service' : 'nominal', service_id || null, amt, buyer_name || null, buyer_phone || null, recipient_name || null, recipient_phone || null, validUntil, req.user?.display_name || null, notes || null]);
        break;
      } catch (e) { if (!/unique/i.test(e.message) || i === 4) throw e; }
    }
    const gc = ins.rows[0];
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'issue',$2,$2,$3,'випуск')`, [gc.id, amt, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'gc.issue', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { code, amount: amt } }).catch(() => {});
    res.json({ ok: true, certificate: gc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET / — список ──
router.get('/', async (req, res) => {
  try {
    const params = [], cond = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`status=$${params.length}`); }
    if (req.query.code) { params.push('%' + req.query.code.toUpperCase() + '%'); cond.push(`code ILIKE $${params.length}`); }
    if (req.query.phone) { params.push('%' + req.query.phone + '%'); cond.push(`(buyer_phone ILIKE $${params.length} OR recipient_phone ILIKE $${params.length})`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(+req.query.limit || 100, 500);
    const r = await pool.query(`SELECT * FROM gift_certificates ${where} ORDER BY created_at DESC LIMIT ${lim}`, params);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /analytics — аналітика ──
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
        COALESCE(SUM(remaining_amount) FILTER (WHERE status IN ('active','partially_used')),0)::numeric AS outstanding_amount
      FROM gift_certificates`, [from, to]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /check/:code — перевірка для каси ──
router.get('/check/:code', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gift_certificates WHERE code=$1`, [req.params.code.toUpperCase()]);
    let gc = r.rows[0];
    if (!gc) return res.json({ valid: false, reason: 'not-found' });
    gc = await refreshExpiry(gc);
    const valid = ['active', 'partially_used'].includes(gc.status) && Number(gc.remaining_amount) > 0;
    res.json({ valid, status: gc.status, id: gc.id, code: gc.code, type: gc.type, service_id: gc.service_id,
      remaining_amount: Number(gc.remaining_amount), original_amount: Number(gc.original_amount), valid_until: gc.valid_until,
      reason: valid ? null : (gc.status === 'expired' ? 'expired' : gc.status === 'cancelled' ? 'cancelled' : gc.status === 'fully_used' ? 'no-balance' : 'inactive') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id — деталі + транзакції ──
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    const tx = await pool.query(`SELECT * FROM gift_certificate_transactions WHERE gc_id=$1 ORDER BY created_at`, [+req.params.id]);
    res.json({ certificate: r.rows[0], transactions: tx.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/use — використати (повне/часткове) ──
router.post('/:id/use', async (req, res) => {
  try {
    const amt = Number(req.body?.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    let gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    gc = await refreshExpiry(gc);
    if (!['active', 'partially_used'].includes(gc.status)) return res.status(409).json({ error: 'not-usable', status: gc.status });
    if (amt > Number(gc.remaining_amount)) return res.status(409).json({ error: 'insufficient-balance', remaining: Number(gc.remaining_amount) });
    const balance = Number(gc.remaining_amount) - amt;
    const newStatus = balance <= 0.001 ? 'fully_used' : 'partially_used';
    const upd = await pool.query(`UPDATE gift_certificates SET remaining_amount=$1, status=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [balance, newStatus, gc.id]);
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,appointment_id,order_id,performed_by,notes) VALUES ($1,'usage',$2,$3,$4,$5,$6,$7)`,
      [gc.id, amt, balance, req.body?.appointment_id || null, req.body?.order_id || null, req.user?.display_name || null, req.body?.notes || null]);
    logAction({ user: req.user, action: 'gc.use', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip, meta: { amount: amt, balance } }).catch(() => {});
    res.json({ ok: true, certificate: upd.rows[0], used: amt, balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/refund — повернення коштів на сертифікат ──
router.post('/:id/refund', async (req, res) => {
  try {
    const amt = Number(req.body?.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount required (> 0)' });
    const gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    if (gc.status === 'cancelled') return res.status(409).json({ error: 'cancelled' });
    const balance = Math.min(Number(gc.remaining_amount) + amt, Number(gc.original_amount));
    const newStatus = balance >= Number(gc.original_amount) ? 'active' : 'partially_used';
    const upd = await pool.query(`UPDATE gift_certificates SET remaining_amount=$1, status=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [balance, newStatus, gc.id]);
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'refund',$2,$3,$4,$5)`,
      [gc.id, amt, balance, req.user?.display_name || null, req.body?.reason || null]);
    res.json({ ok: true, certificate: upd.rows[0], balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/cancel — анулювати ──
router.post('/:id/cancel', async (req, res) => {
  try {
    const gc = (await pool.query(`SELECT * FROM gift_certificates WHERE id=$1`, [+req.params.id])).rows[0];
    if (!gc) return res.status(404).json({ error: 'not found' });
    if (gc.status === 'cancelled') return res.json({ ok: true, certificate: gc });
    const upd = await pool.query(`UPDATE gift_certificates SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`, [gc.id]);
    await pool.query(`INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,performed_by,notes) VALUES ($1,'cancellation',$2,$2,$3,$4)`,
      [gc.id, gc.remaining_amount, req.user?.display_name || null, req.body?.reason || 'анульовано']);
    logAction({ user: req.user, action: 'gc.cancel', entity: 'gift_certificate', entity_id: gc.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, certificate: upd.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
