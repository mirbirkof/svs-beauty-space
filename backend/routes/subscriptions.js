/* routes/subscriptions.js — SLS-09 Абонементи.
   Тарифні плани, продаж, списання візитів/хвилин, заморозка/розморозка,
   перенесення, повернення/розірвання, перевірка для каси, аналітика.
   Прагматична версія для 1 салону без recurring-billing з картами.
   Доступ: GET = cashbox.read, мутації = cashbox.write (касова функція). */
const express = require('express');
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
function addDays(dateStr, days) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}
// SUB-2026-NNNN (рік + порядковий за рік)
async function genNumber() {
  const year = kyivToday().slice(0, 4);
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE subscription_number LIKE $1`, [`SUB-${year}-%`]);
  const seq = String(r.rows[0].c + 1).padStart(4, '0');
  return `SUB-${year}-${seq}`;
}
// Ліниве протермінування
async function refreshExpiry(sub) {
  if (sub && ['active', 'frozen'].includes(sub.status) && sub.status !== 'frozen' && sub.expires_at && String(sub.expires_at).slice(0, 10) < kyivToday()) {
    await pool.query(`UPDATE subscriptions SET status='expired', updated_at=NOW() WHERE id=$1`, [sub.id]);
    sub.status = 'expired';
  }
  return sub;
}

// ════════ ТАРИФНІ ПЛАНИ ════════

// GET /plans — список планів
router.get('/plans', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.active !== undefined) { params.push(req.query.active === 'true'); cond.push(`active=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(`SELECT * FROM subscription_plans ${where} ORDER BY sort_order, id`, params);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /plans — створити план
router.post('/plans', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    if (!b.price || Number(b.price) <= 0) return res.status(400).json({ error: 'price required (> 0)' });
    const type = ['visits', 'time', 'minutes', 'combo'].includes(b.type) ? b.type : 'visits';
    const r = await pool.query(
      `INSERT INTO subscription_plans
        (name,description,type,visits_included,minutes_included,duration_days,price,service_ids,category_ids,
         master_restriction,master_ids,auto_renew,max_freezes,max_freeze_days,carry_over_visits,max_carry_over,max_users,active,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [b.name, b.description || null, type, b.visits_included || null, b.minutes_included || null,
       Number(b.duration_days) > 0 ? Number(b.duration_days) : 365, Number(b.price),
       Array.isArray(b.service_ids) ? b.service_ids : [], Array.isArray(b.category_ids) ? b.category_ids : [],
       b.master_restriction === 'specific' ? 'specific' : 'any', Array.isArray(b.master_ids) ? b.master_ids : [],
       !!b.auto_renew, b.max_freezes ?? 2, b.max_freeze_days ?? 14, !!b.carry_over_visits, b.max_carry_over ?? 0,
       b.max_users > 0 ? b.max_users : 1, b.active !== false, b.sort_order ?? 0]);
    logAction({ user: req.user, action: 'subscription.plan.create', entity: 'subscription_plan', entity_id: r.rows[0].id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /plans/:id — оновити план
router.patch('/plans/:id', async (req, res) => {
  try {
    const allow = ['name', 'description', 'type', 'visits_included', 'minutes_included', 'duration_days', 'price',
      'service_ids', 'category_ids', 'master_restriction', 'master_ids', 'auto_renew', 'max_freezes', 'max_freeze_days',
      'carry_over_visits', 'max_carry_over', 'max_users', 'active', 'sort_order'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE subscription_plans SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════ АБОНЕМЕНТИ ════════

// GET / — список абонементів
router.get('/', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.client_id) { params.push(+req.query.client_id); cond.push(`s.client_id=$${params.length}`); }
    if (req.query.status) { params.push(req.query.status); cond.push(`s.status=$${params.length}`); }
    if (req.query.plan_id) { params.push(+req.query.plan_id); cond.push(`s.plan_id=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(+req.query.limit || 50, 200);
    const off = +req.query.offset || 0;
    const r = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.type AS plan_type, c.name AS client_name, c.phone AS client_phone
       FROM subscriptions s
       JOIN subscription_plans p ON p.id=s.plan_id
       LEFT JOIN clients c ON c.id=s.client_id
       ${where} ORDER BY s.created_at DESC LIMIT ${lim} OFFSET ${off}`, params);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /analytics — аналітика
router.get('/analytics', async (req, res) => {
  try {
    const from = (req.query.from || '2000-01-01') + ' 00:00:00+03';
    const to = (req.query.to || kyivToday()) + ' 23:59:59+03';
    const sold = await pool.query(`
      SELECT COUNT(*)::int AS sold_count, COALESCE(SUM(p.price),0)::numeric AS sold_amount
      FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
      WHERE s.created_at BETWEEN $1 AND $2`, [from, to]);
    const active = await pool.query(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE status IN ('active','frozen')`);
    // середній % використання по завершених/активних visits-абонементах
    const usage = await pool.query(`
      SELECT COALESCE(AVG(CASE WHEN p.visits_included>0
        THEN (p.visits_included - COALESCE(s.visits_remaining,0))::numeric / p.visits_included * 100 END),0)::numeric(10,1) AS avg_usage_percent
      FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
      WHERE p.type IN ('visits','combo')`);
    // churn: expired+cancelled / всі (грубо)
    const churn = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status IN ('expired','cancelled'))::numeric AS lost, COUNT(*)::numeric AS total
      FROM subscriptions`);
    const ch = Number(churn.rows[0].total) > 0 ? (Number(churn.rows[0].lost) / Number(churn.rows[0].total) * 100) : 0;
    const top = await pool.query(`
      SELECT p.id, p.name, COUNT(*)::int AS sales, COALESCE(SUM(p.price),0)::numeric AS revenue
      FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
      WHERE s.created_at BETWEEN $1 AND $2 GROUP BY p.id, p.name ORDER BY sales DESC LIMIT 5`, [from, to]);
    res.json({
      sold_count: sold.rows[0].sold_count,
      sold_amount: Number(sold.rows[0].sold_amount),
      active_count: active.rows[0].c,
      avg_usage_percent: Number(usage.rows[0].avg_usage_percent),
      churn_rate: Math.round(ch * 10) / 10,
      top_plans: top.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /check/:client_id — перевірка абонемента клієнта для каси/запису
router.get('/check/:client_id', async (req, res) => {
  try {
    const cid = +req.params.client_id;
    const sid = req.query.service_id ? +req.query.service_id : null;
    const r = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.type AS plan_type, p.service_ids, p.category_ids
       FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
       WHERE s.client_id=$1 AND s.status='active'
       ORDER BY s.expires_at ASC`, [cid]);
    const today = kyivToday();
    for (let sub of r.rows) {
      if (String(sub.expires_at).slice(0, 10) < today) continue;
      // перевірка послуги (порожній service_ids = будь-яка)
      if (sid && Array.isArray(sub.service_ids) && sub.service_ids.length && !sub.service_ids.includes(sid)) continue;
      const hasBalance = sub.plan_type === 'minutes'
        ? Number(sub.minutes_remaining) > 0
        : (sub.plan_type === 'time' ? true : Number(sub.visits_remaining) > 0);
      if (!hasBalance) continue;
      return res.json({
        has_active: true, subscription_id: sub.id, subscription_number: sub.subscription_number,
        plan_name: sub.plan_name, plan_type: sub.plan_type,
        visits_remaining: sub.visits_remaining, minutes_remaining: sub.minutes_remaining, valid_until: sub.expires_at
      });
    }
    res.json({ has_active: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — деталі (план, історія, заморозки, користувачі)
router.get('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const r = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.type AS plan_type, c.name AS client_name, c.phone AS client_phone
       FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id LEFT JOIN clients c ON c.id=s.client_id
       WHERE s.id=$1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    let sub = r.rows[0];
    sub = await refreshExpiry(sub);
    const usage = await pool.query(`SELECT * FROM subscription_usage WHERE subscription_id=$1 ORDER BY created_at DESC`, [id]);
    const freezes = await pool.query(`SELECT * FROM subscription_freezes WHERE subscription_id=$1 ORDER BY frozen_at DESC`, [id]);
    const users = await pool.query(
      `SELECT su.*, c.name AS client_name, c.phone AS client_phone FROM subscription_users su
       LEFT JOIN clients c ON c.id=su.client_id WHERE su.subscription_id=$1 AND su.removed_at IS NULL`, [id]);
    res.json({ subscription: sub, usage_history: usage.rows, freezes: freezes.rows, users: users.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — продати абонемент
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.plan_id || !b.client_id) return res.status(400).json({ error: 'plan_id, client_id required' });
    const plan = (await pool.query(`SELECT * FROM subscription_plans WHERE id=$1`, [+b.plan_id])).rows[0];
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    if (!plan.active) return res.status(409).json({ error: 'plan inactive' });
    const start = b.start_date || kyivToday();
    const expires = addDays(start, plan.duration_days || 365);
    const number = await genNumber();
    const visitsRem = ['visits', 'combo'].includes(plan.type) ? plan.visits_included : null;
    const minutesRem = plan.type === 'minutes' ? plan.minutes_included : null;
    const ins = await pool.query(
      `INSERT INTO subscriptions
        (plan_id,client_id,subscription_number,status,visits_remaining,minutes_remaining,started_at,expires_at,auto_renew,sold_by,notes)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [plan.id, +b.client_id, number, visitsRem, minutesRem, start, expires, !!b.auto_renew, req.user?.display_name || null, b.notes || null]);
    const sub = ins.rows[0];
    // primary користувач
    await pool.query(`INSERT INTO subscription_users (subscription_id,client_id,is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [sub.id, +b.client_id]);
    logAction({ user: req.user, action: 'subscription.sell', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { number, plan: plan.name, price: plan.price } }).catch(() => {});
    res.json({ ok: true, subscription: sub, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/use — списати візит/хвилини
router.post('/:id/use', async (req, res) => {
  try {
    const qty = Number(req.body?.quantity) > 0 ? Number(req.body.quantity) : 1;
    let sub = (await pool.query(`SELECT s.*, p.type AS plan_type FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    sub = await refreshExpiry(sub);
    if (sub.status !== 'active') return res.status(409).json({ error: 'not-active', status: sub.status });
    const isMinutes = sub.plan_type === 'minutes';
    const isTime = sub.plan_type === 'time';
    let balance = null, col = null;
    if (!isTime) {
      col = isMinutes ? 'minutes_remaining' : 'visits_remaining';
      const cur = Number(sub[col]);
      if (qty > cur) return res.status(409).json({ error: 'insufficient-balance', remaining: cur });
      balance = cur - qty;
    }
    const newStatus = (!isTime && balance <= 0) ? 'expired' : 'active';
    if (!isTime) {
      await pool.query(`UPDATE subscriptions SET ${col}=$1, status=$2, updated_at=NOW() WHERE id=$3`, [balance, newStatus, sub.id]);
    }
    await pool.query(
      `INSERT INTO subscription_usage (subscription_id,client_id,appointment_id,type,quantity,balance_after,performed_by,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sub.id, req.body?.client_id || sub.client_id, req.body?.appointment_id || null, isMinutes ? 'minutes' : 'visit', qty, balance ?? 0, req.user?.display_name || null, req.body?.notes || null]);
    logAction({ user: req.user, action: 'subscription.use', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { qty, balance } }).catch(() => {});
    res.json({ ok: true, balance, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/freeze — заморозити
router.post('/:id/freeze', async (req, res) => {
  try {
    const sub = (await pool.query(`SELECT s.*, p.max_freezes, p.max_freeze_days FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    if (sub.status !== 'active') return res.status(409).json({ error: 'not-active', status: sub.status });
    if (sub.freeze_count >= sub.max_freezes) return res.status(409).json({ error: 'max-freezes-reached', max: sub.max_freezes });
    const unfreeze = req.body?.unfreeze_at || addDays(kyivToday(), Math.min(Number(req.body?.days) || sub.max_freeze_days, sub.max_freeze_days));
    await pool.query(`UPDATE subscriptions SET status='frozen', frozen_at=NOW(), unfreeze_at=$1, freeze_count=freeze_count+1, updated_at=NOW() WHERE id=$2`, [unfreeze, sub.id]);
    await pool.query(`INSERT INTO subscription_freezes (subscription_id,frozen_at,reason) VALUES ($1,NOW(),$2)`, [sub.id, req.body?.reason || null]);
    logAction({ user: req.user, action: 'subscription.freeze', entity: 'subscription', entity_id: sub.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, unfreeze_at: unfreeze });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/unfreeze — розморозити (продовжує строк на дні заморозки)
router.post('/:id/unfreeze', async (req, res) => {
  try {
    const sub = (await pool.query(`SELECT * FROM subscriptions WHERE id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    if (sub.status !== 'frozen') return res.status(409).json({ error: 'not-frozen', status: sub.status });
    const frozenDays = sub.frozen_at ? Math.max(1, Math.ceil((Date.now() - new Date(sub.frozen_at).getTime()) / 86400000)) : 0;
    const newExpires = addDays(String(sub.expires_at).slice(0, 10), frozenDays);
    await pool.query(`UPDATE subscriptions SET status='active', frozen_at=NULL, unfreeze_at=NULL, expires_at=$1, total_frozen_days=total_frozen_days+$2, updated_at=NOW() WHERE id=$3`, [newExpires, frozenDays, sub.id]);
    await pool.query(`UPDATE subscription_freezes SET unfrozen_at=NOW(), days=$1 WHERE subscription_id=$2 AND unfrozen_at IS NULL`, [frozenDays, sub.id]);
    logAction({ user: req.user, action: 'subscription.unfreeze', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { frozenDays } }).catch(() => {});
    res.json({ ok: true, expires_at: newExpires, frozen_days: frozenDays });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/cancel — розірвати
router.post('/:id/cancel', async (req, res) => {
  try {
    const sub = (await pool.query(`SELECT * FROM subscriptions WHERE id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    if (sub.status === 'cancelled') return res.json({ ok: true, subscription: sub });
    const upd = await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [req.body?.reason || null, sub.id]);
    logAction({ user: req.user, action: 'subscription.cancel', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { refund: req.body?.refund_amount } }).catch(() => {});
    res.json({ ok: true, subscription: upd.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/users — додати користувача (сімейний)
router.post('/:id/users', async (req, res) => {
  try {
    const id = +req.params.id;
    if (!req.body?.client_id) return res.status(400).json({ error: 'client_id required' });
    const sub = (await pool.query(`SELECT s.*, p.max_users FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    const cnt = (await pool.query(`SELECT COUNT(*)::int AS c FROM subscription_users WHERE subscription_id=$1 AND removed_at IS NULL`, [id])).rows[0].c;
    if (cnt >= sub.max_users) return res.status(409).json({ error: 'max-users-reached', max: sub.max_users });
    await pool.query(`INSERT INTO subscription_users (subscription_id,client_id) VALUES ($1,$2)
      ON CONFLICT (subscription_id,client_id) DO UPDATE SET removed_at=NULL`, [id, +req.body.client_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/users/:client_id — видалити користувача
router.delete('/:id/users/:client_id', async (req, res) => {
  try {
    await pool.query(`UPDATE subscription_users SET removed_at=NOW() WHERE subscription_id=$1 AND client_id=$2 AND is_primary=false`, [+req.params.id, +req.params.client_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
