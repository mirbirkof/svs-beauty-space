/* routes/subscriptions.js — SLS-09 Абонементи.
   Тарифні плани, продаж, списання візитів/хвилин, заморозка/розморозка,
   перенесення, повернення/розірвання, перевірка для каси, аналітика.
   Прагматична версія для 1 салону без recurring-billing з картами.
   Доступ: GET = cashbox.read, мутації = cashbox.write (касова функція). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { recordCashIn } = require('../lib/cash-ledger');

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
// Ліниве протермінування + авто-розморозка по даті + вихід з grace-period.
async function refreshExpiry(sub) {
  if (!sub) return sub;
  const today = kyivToday();
  // Авто-розморозка, якщо настала дата unfreeze_at (продовжуємо строк на дні заморозки).
  if (sub.status === 'frozen' && sub.unfreeze_at && String(sub.unfreeze_at).slice(0, 10) <= today) {
    const frozenDays = sub.frozen_at ? Math.max(1, Math.ceil((Date.now() - new Date(sub.frozen_at).getTime()) / 86400000)) : 0;
    const newExpires = addDays(String(sub.expires_at).slice(0, 10), frozenDays);
    await pool.query(`UPDATE subscriptions SET status='active', frozen_at=NULL, unfreeze_at=NULL, expires_at=$1, total_frozen_days=total_frozen_days+$2, updated_at=NOW() WHERE id=$3`, [newExpires, frozenDays, sub.id]);
    await pool.query(`UPDATE subscription_freezes SET unfrozen_at=NOW(), days=$1 WHERE subscription_id=$2 AND unfrozen_at IS NULL`, [frozenDays, sub.id]);
    sub.status = 'active'; sub.expires_at = newExpires; sub.frozen_at = null; sub.unfreeze_at = null;
  }
  // Протермінування активних/grace по строку дії.
  if (['active', 'trial', 'grace_period'].includes(sub.status) && sub.expires_at && String(sub.expires_at).slice(0, 10) < today) {
    // grace_period: ще даємо дожити до grace_until.
    if (sub.status === 'grace_period' && sub.grace_until && String(sub.grace_until).slice(0, 10) >= today) return sub;
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /plans — створити план
router.post('/plans', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    // Аудит: Number(x)<=0 НЕ ловит NaN (NaN<=0===false) → нечисловая цена проходила и уходила
    // в БД как NaN, ломая продажу абонемента. Требуем настоящее конечное положительное число.
    if (!Number.isFinite(Number(b.price)) || Number(b.price) <= 0) return res.status(400).json({ error: 'price required (> 0)' });
    // доп.цены — только если конечное число, иначе null (не NaN)
    const priceMonthly = (b.price_monthly != null && Number.isFinite(Number(b.price_monthly))) ? Number(b.price_monthly) : null;
    const trialPrice = (b.trial_price != null && Number.isFinite(Number(b.trial_price))) ? Number(b.trial_price) : null;
    const type = ['visits', 'time', 'minutes', 'combo'].includes(b.type) ? b.type : 'visits';
    const r = await pool.query(
      `INSERT INTO subscription_plans
        (name,description,type,visits_included,minutes_included,duration_days,price,price_monthly,trial_price,trial_days,
         service_ids,category_ids,master_restriction,master_ids,branch_ids,branch_id,
         auto_renew,max_freezes,max_freeze_days,carry_over_visits,max_carry_over,renew_grace_days,max_users,active,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [b.name, b.description || null, type, b.visits_included || null, b.minutes_included || null,
       Number(b.duration_days) > 0 ? Number(b.duration_days) : 365, Number(b.price),
       priceMonthly, trialPrice,
       Number(b.trial_days) > 0 ? Number(b.trial_days) : null,
       Array.isArray(b.service_ids) ? b.service_ids : [], Array.isArray(b.category_ids) ? b.category_ids : [],
       b.master_restriction === 'specific' ? 'specific' : 'any', Array.isArray(b.master_ids) ? b.master_ids : [],
       Array.isArray(b.branch_ids) ? b.branch_ids : [], b.branch_id || null,
       !!b.auto_renew, b.max_freezes ?? 2, b.max_freeze_days ?? 14, !!b.carry_over_visits, b.max_carry_over ?? 0,
       b.renew_grace_days ?? 3, b.max_users > 0 ? b.max_users : 1, b.active !== false, b.sort_order ?? 0]);
    logAction({ user: req.user, action: 'subscription.plan.create', entity: 'subscription_plan', entity_id: r.rows[0].id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /plans/:id — оновити план
router.patch('/plans/:id', async (req, res) => {
  try {
    const allow = ['name', 'description', 'type', 'visits_included', 'minutes_included', 'duration_days', 'price',
      'price_monthly', 'trial_price', 'trial_days', 'service_ids', 'category_ids', 'master_restriction', 'master_ids',
      'branch_ids', 'branch_id', 'auto_renew', 'max_freezes', 'max_freeze_days', 'carry_over_visits', 'max_carry_over',
      'renew_grace_days', 'max_users', 'active', 'sort_order'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE subscription_plans SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
    // MRR: нормалізована місячна виручка по активних абонементах (помісячна ціна або price/міс по строку).
    const mrrR = await pool.query(`
      SELECT COALESCE(SUM(
        CASE WHEN p.price_monthly IS NOT NULL AND p.price_monthly > 0 THEN p.price_monthly
             WHEN p.duration_days > 0 THEN p.price / (p.duration_days / 30.0)
             ELSE 0 END),0)::numeric(12,2) AS mrr
      FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
      WHERE s.status IN ('active','trial','frozen','grace_period')`);
    // Середній строк життя клієнта на абонементі (місяців) по завершених/відмінених.
    const lifeR = await pool.query(`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(s.cancelled_at, s.updated_at) - s.created_at)) / 86400 / 30.0),0)::numeric(10,1) AS avg_months
      FROM subscriptions s WHERE s.status IN ('expired','cancelled')`);
    // Retention: % абонементів з auto_renew, що мають >1 платіж (продовжили).
    const retR = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE pay_cnt > 1)::numeric AS renewed, COUNT(*)::numeric AS total
      FROM (SELECT s.id, COUNT(sp.id) AS pay_cnt FROM subscriptions s
            LEFT JOIN subscription_payments sp ON sp.subscription_id=s.id AND sp.status='paid'
            GROUP BY s.id) q`);
    const retained = Number(retR.rows[0].total) > 0 ? Number(retR.rows[0].renewed) / Number(retR.rows[0].total) * 100 : 0;
    res.json({
      sold_count: sold.rows[0].sold_count,
      sold_amount: Number(sold.rows[0].sold_amount),
      active_count: active.rows[0].c,
      mrr: Number(mrrR.rows[0].mrr),
      avg_usage_percent: Number(usage.rows[0].avg_usage_percent),
      churn_rate: Math.round(ch * 10) / 10,
      retention_rate: Math.round(retained * 10) / 10,
      avg_lifetime_months: Number(lifeR.rows[0].avg_months),
      top_plans: top.rows
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /expiring — абонементи що скоро закінчуються/закінчуються візити (для COM-01 нагадувань)
router.get('/expiring', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const lowVisits = parseInt(req.query.low_visits, 10) || 2;
    const limit = String(addDays(kyivToday(), days));
    const r = await pool.query(`
      SELECT s.id, s.subscription_number, s.client_id, s.status, s.expires_at,
             s.visits_remaining, s.minutes_remaining, s.expiry_notified_at,
             p.name AS plan_name, p.type AS plan_type, c.name AS client_name, c.phone AS client_phone
      FROM subscriptions s
      JOIN subscription_plans p ON p.id=s.plan_id
      LEFT JOIN clients c ON c.id=s.client_id
      WHERE s.status IN ('active','trial')
        AND ( s.expires_at <= $1
              OR (p.type IN ('visits','combo') AND COALESCE(s.visits_remaining,0) <= $2 AND COALESCE(s.visits_remaining,0) > 0)
              OR (p.type='minutes' AND COALESCE(s.minutes_remaining,0) <= $3 AND COALESCE(s.minutes_remaining,0) > 0) )
      ORDER BY s.expires_at ASC`, [limit, lowVisits, lowVisits * 30]);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /check/:client_id — перевірка абонемента клієнта для каси/запису
router.get('/check/:client_id', async (req, res) => {
  try {
    const cid = +req.params.client_id;
    const sid = req.query.service_id ? +req.query.service_id : null;
    const branch = req.query.branch_id ? +req.query.branch_id : null;
    // Власні + сімейні абонементи (клієнт може бути доданий до чужого як subscription_users).
    const r = await pool.query(
      `SELECT DISTINCT s.*, p.name AS plan_name, p.type AS plan_type, p.service_ids, p.category_ids, p.branch_ids
       FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
       LEFT JOIN subscription_users su ON su.subscription_id=s.id AND su.removed_at IS NULL
       WHERE (s.client_id=$1 OR su.client_id=$1) AND s.status IN ('active','trial')
       ORDER BY s.expires_at ASC`, [cid]);
    const today = kyivToday();
    for (let sub of r.rows) {
      if (String(sub.expires_at).slice(0, 10) < today) continue;
      // перевірка послуги (порожній service_ids = будь-яка)
      if (sid && Array.isArray(sub.service_ids) && sub.service_ids.length && !sub.service_ids.includes(sid)) continue;
      // перевірка філії (порожній branch_ids = всі)
      if (branch && Array.isArray(sub.branch_ids) && sub.branch_ids.length && !sub.branch_ids.includes(branch)) continue;
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
    // Trial-період: якщо план має trial і клієнт явно/неявно його бере, строк = trial_days, ціна = trial_price.
    const useTrial = b.trial === true && Number(plan.trial_days) > 0;
    const durDays = useTrial ? Number(plan.trial_days) : (plan.duration_days || 365);
    const expires = addDays(start, durDays);
    const trialEnds = useTrial ? expires : null;
    const status = useTrial ? 'trial' : 'active';
    const price = useTrial ? (plan.trial_price != null ? Number(plan.trial_price) : 0)
                : (b.payment_method === 'monthly' && plan.price_monthly != null ? Number(plan.price_monthly) : Number(plan.price));
    const number = await genNumber();
    const visitsRem = ['visits', 'combo'].includes(plan.type) ? plan.visits_included : null;
    const minutesRem = plan.type === 'minutes' ? plan.minutes_included : null;
    const ins = await pool.query(
      `INSERT INTO subscriptions
        (plan_id,client_id,branch_id,subscription_number,status,visits_remaining,minutes_remaining,started_at,expires_at,
         auto_renew,payment_method,is_trial,trial_ends_at,sold_by,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [plan.id, +b.client_id, b.branch_id || null, number, status, visitsRem, minutesRem, start, expires,
       !!b.auto_renew, b.payment_method || b.method || 'cash', useTrial, trialEnds, req.user?.display_name || null, b.notes || null]);
    const sub = ins.rows[0];
    // primary користувач
    await pool.query(`INSERT INTO subscription_users (subscription_id,client_id,is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [sub.id, +b.client_id]);
    // деньги в кассу/ДДС: продажа абонемента (аудит 22.06 #12). Идемпотентно по ext_ref.
    let cashOpId = null;
    if (price > 0) {
      cashOpId = await recordCashIn({ category: 'sale_subscription', amount: price, method: b.method || b.payment_method || 'cash', ref_type: 'subscription', ref_id: sub.id, description: `Продаж абонемента ${number} (${plan.name})${useTrial ? ' [trial]' : ''}`, ext_ref: `sub:sell:${sub.id}` }).catch(e => { console.error('cash-ledger sub:', e.message); return null; });
    }
    // Запис платежу (recurring billing leg).
    await pool.query(
      `INSERT INTO subscription_payments (subscription_id,amount,period_start,period_end,status,payment_method,cashbox_op_id,attempt,notes)
       VALUES ($1,$2,$3,$4,'paid',$5,$6,1,$7)`,
      [sub.id, price, start, expires, b.method || b.payment_method || 'cash', cashOpId, useTrial ? 'trial' : 'sale']).catch(e => console.error('sub-payment:', e.message));
    logAction({ user: req.user, action: 'subscription.sell', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { number, plan: plan.name, price, trial: useTrial } }).catch(() => {});
    res.json({ ok: true, subscription: sub, plan });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/use — списати візит/хвилини
router.post('/:id/use', async (req, res) => {
  try {
    const qty = Number(req.body?.quantity) > 0 ? Number(req.body.quantity) : 1;
    let sub = (await pool.query(`SELECT s.*, p.type AS plan_type FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    sub = await refreshExpiry(sub);
    if (!['active', 'trial'].includes(sub.status)) return res.status(409).json({ error: 'not-active', status: sub.status });
    // Аудит v6: двойной клик кассира с тем же appointment_id сжигал 2 визита.
    // Идемпотентность: визит по этой записи уже списан → возвращаем ok без повторного списания.
    if (req.body?.appointment_id) {
      const dup = await pool.query(
        `SELECT balance_after FROM subscription_usage
          WHERE subscription_id=$1 AND appointment_id=$2 LIMIT 1`,
        [sub.id, req.body.appointment_id]);
      if (dup.rows[0]) {
        return res.json({ ok: true, balance: Number(dup.rows[0].balance_after), status: sub.status, already_used: true });
      }
    }
    const isMinutes = sub.plan_type === 'minutes';
    const isTime = sub.plan_type === 'time';
    let balance = null, col = null, newStatus = sub.status;
    if (!isTime) {
      col = isMinutes ? 'minutes_remaining' : 'visits_remaining';
      const cur = Number(sub[col]);
      if (qty > cur) return res.status(409).json({ error: 'insufficient-balance', remaining: cur });
      // Атомарне списання: умовний UPDATE (col >= qty) закриває гонку read-modify-write —
      // раніше баланс читався (325), віднімався в JS і писався готовим значенням без умови,
      // тож два паралельних /use списували абонемент ДВІЧІ за одну ціну.
      // status='expired' при нульовому остатку; trial зберігає статус доки є баланс і строк.
      const upd = await pool.query(
        `UPDATE subscriptions
            SET ${col} = ${col} - $1,
                status = CASE WHEN ${col} - $1 <= 0 THEN 'expired' ELSE status END,
                updated_at = NOW()
          WHERE id = $2 AND ${col} >= $1 AND status IN ('active','trial')
          RETURNING ${col} AS bal, status AS st`, [qty, sub.id]);
      if (!upd.rows[0]) return res.status(409).json({ error: 'insufficient-balance', message: 'Абонемент щойно списано або вичерпано. Оновіть сторінку.' });
      balance = Number(upd.rows[0].bal);
      newStatus = upd.rows[0].st;
    }
    await pool.query(
      `INSERT INTO subscription_usage (subscription_id,client_id,appointment_id,type,quantity,balance_after,performed_by,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sub.id, req.body?.client_id || sub.client_id, req.body?.appointment_id || null, isMinutes ? 'minutes' : 'visit', qty, balance ?? 0, req.user?.display_name || null, req.body?.notes || null]);
    logAction({ user: req.user, action: 'subscription.use', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { qty, balance } }).catch(() => {});
    res.json({ ok: true, balance, status: newStatus });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/freeze — заморозити
router.post('/:id/freeze', async (req, res) => {
  try {
    const sub = (await pool.query(`SELECT s.*, p.max_freezes, p.max_freeze_days FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [+req.params.id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    if (sub.status !== 'active') return res.status(409).json({ error: 'not-active', status: sub.status });
    if (sub.freeze_count >= sub.max_freezes) return res.status(409).json({ error: 'max-freezes-reached', max: sub.max_freezes });
    // Аудит v6: явный unfreeze_at из body обходил лимит max_freeze_days — клампим к потолку плана.
    const maxUnfreeze = addDays(kyivToday(), sub.max_freeze_days);
    let unfreeze = req.body?.unfreeze_at || addDays(kyivToday(), Math.min(Number(req.body?.days) || sub.max_freeze_days, sub.max_freeze_days));
    if (String(unfreeze) > String(maxUnfreeze)) unfreeze = maxUnfreeze;
    await pool.query(`UPDATE subscriptions SET status='frozen', frozen_at=NOW(), unfreeze_at=$1, freeze_count=freeze_count+1, updated_at=NOW() WHERE id=$2`, [unfreeze, sub.id]);
    await pool.query(`INSERT INTO subscription_freezes (subscription_id,frozen_at,reason) VALUES ($1,NOW(),$2)`, [sub.id, req.body?.reason || null]);
    logAction({ user: req.user, action: 'subscription.freeze', entity: 'subscription', entity_id: sub.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, unfreeze_at: unfreeze });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /:id/users/:client_id — видалити користувача
router.delete('/:id/users/:client_id', async (req, res) => {
  try {
    await pool.query(`UPDATE subscription_users SET removed_at=NOW() WHERE subscription_id=$1 AND client_id=$2 AND is_primary=false`, [+req.params.id, +req.params.client_id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /:id/usage — історія списань (окремим ендпоінтом, з пагінацією)
router.get('/:id/usage', async (req, res) => {
  try {
    const lim = Math.min(+req.query.limit || 100, 500);
    const off = Math.max(+req.query.offset || 0, 0);
    const r = await pool.query(
      `SELECT u.*, c.name AS client_name FROM subscription_usage u
       LEFT JOIN clients c ON c.id=u.client_id
       WHERE u.subscription_id=$1 ORDER BY u.created_at DESC LIMIT ${lim} OFFSET ${off}`, [+req.params.id]);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /:id/payments — історія платежів
router.get('/:id/payments', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM subscription_payments WHERE subscription_id=$1 ORDER BY created_at DESC`, [+req.params.id]);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/payments — зафіксувати платіж (помісячне списання / повторна спроба)
router.post('/:id/payments', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const sub = (await pool.query(`SELECT s.*, p.name AS plan_name, p.price_monthly, p.renew_grace_days FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    const amount = Number(b.amount) > 0 ? Number(b.amount) : Number(sub.price_monthly) || 0;
    const status = ['paid', 'pending', 'failed', 'refunded'].includes(b.status) ? b.status : 'paid';
    const attempt = (sub.failed_payments || 0) + 1;
    let cashOpId = null;
    if (status === 'paid' && amount > 0) {
      cashOpId = await recordCashIn({ category: 'sale_subscription', amount, method: b.payment_method || 'card', ref_type: 'subscription', ref_id: sub.id, description: `Платіж по абонементу ${sub.subscription_number}`, ext_ref: `sub:pay:${sub.id}:${Date.now()}` }).catch(() => null);
    }
    const ins = await pool.query(
      `INSERT INTO subscription_payments (subscription_id,amount,period_start,period_end,status,payment_method,cashbox_op_id,attempt,next_retry_at,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [sub.id, amount, b.period_start || null, b.period_end || null, status, b.payment_method || 'card', cashOpId,
       status === 'failed' ? attempt : 1, b.next_retry_at || null, b.notes || null]);
    // Обробка статусу автопродовження.
    if (status === 'paid') {
      await pool.query(`UPDATE subscriptions SET failed_payments=0, grace_until=NULL, status=CASE WHEN status='grace_period' THEN 'active' ELSE status END, updated_at=NOW() WHERE id=$1`, [sub.id]);
    } else if (status === 'failed') {
      // 3 спроби → grace-period → деактивація.
      if (attempt >= 3) {
        await pool.query(`UPDATE subscriptions SET failed_payments=$1, status='cancelled', cancelled_at=NOW(), cancel_reason='auto: payment failed x3', updated_at=NOW() WHERE id=$2`, [attempt, sub.id]);
      } else {
        const grace = addDays(kyivToday(), sub.renew_grace_days || 3);
        await pool.query(`UPDATE subscriptions SET failed_payments=$1, status='grace_period', grace_until=$2, updated_at=NOW() WHERE id=$3`, [attempt, grace, sub.id]);
      }
    }
    logAction({ user: req.user, action: 'subscription.payment', entity: 'subscription', entity_id: sub.id, ip: req.ip, meta: { amount, status, attempt } }).catch(() => {});
    res.json({ ok: true, payment: ins.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/adjust — ручна корекція остатку/строку (09.03, з аудитом)
router.post('/:id/adjust', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const sub = (await pool.query(`SELECT s.*, p.type AS plan_type FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    const field = b.field;
    if (!['visits_remaining', 'minutes_remaining', 'expires_at'].includes(field)) return res.status(400).json({ error: 'field: visits_remaining|minutes_remaining|expires_at' });
    let newVal, delta = null;
    if (field === 'expires_at') {
      if (!b.value) return res.status(400).json({ error: 'value (date) required' });
      newVal = String(b.value).slice(0, 10);
    } else {
      const cur = Number(sub[field]) || 0;
      newVal = b.value != null ? Number(b.value) : cur + (Number(b.delta) || 0);
      if (!(newVal >= 0)) return res.status(400).json({ error: 'value must be >= 0' });
      delta = newVal - cur;
    }
    const upd = (await pool.query(`UPDATE subscriptions SET ${field}=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [newVal, id])).rows[0];
    await pool.query(
      `INSERT INTO subscription_adjustments (subscription_id,field,old_value,new_value,delta,reason,performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, field, String(sub[field] ?? ''), String(newVal), delta, b.reason || null, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'subscription.adjust', entity: 'subscription', entity_id: id, ip: req.ip, meta: { field, delta, reason: b.reason } }).catch(() => {});
    res.json({ ok: true, subscription: upd });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/renew — продовжити абонемент (новий період, перенесення невикористаних візитів)
router.post('/:id/renew', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    let sub = (await pool.query(`SELECT * FROM subscriptions WHERE id=$1`, [id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    sub = await refreshExpiry(sub);
    if (['cancelled'].includes(sub.status)) return res.status(409).json({ error: 'cancelled' });
    const plan = (await pool.query(`SELECT * FROM subscription_plans WHERE id=$1`, [sub.plan_id])).rows[0];
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    // Перенесення невикористаних візитів (якщо план дозволяє).
    let carry = 0;
    if (plan.carry_over_visits && ['visits', 'combo'].includes(plan.type)) {
      carry = Math.min(Number(sub.visits_remaining) || 0, Number(plan.max_carry_over) || 0);
    }
    const start = b.start_date || (String(sub.expires_at).slice(0, 10) >= kyivToday() ? String(sub.expires_at).slice(0, 10) : kyivToday());
    const expires = addDays(start, plan.duration_days || 365);
    const number = await genNumber();
    const visitsRem = ['visits', 'combo'].includes(plan.type) ? (Number(plan.visits_included) || 0) + carry : null;
    const minutesRem = plan.type === 'minutes' ? plan.minutes_included : null;
    const price = b.payment_method === 'monthly' && plan.price_monthly != null ? Number(plan.price_monthly) : Number(plan.price);
    const ins = await pool.query(
      `INSERT INTO subscriptions
        (plan_id,client_id,branch_id,subscription_number,status,visits_remaining,minutes_remaining,started_at,expires_at,
         auto_renew,payment_method,carried_over,renewed_from_id,sold_by,notes)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [plan.id, sub.client_id, sub.branch_id, number, visitsRem, minutesRem, start, expires,
       sub.auto_renew, b.payment_method || 'cash', carry, sub.id, req.user?.display_name || null, b.notes || null]);
    const next = ins.rows[0];
    await pool.query(`INSERT INTO subscription_users (subscription_id,client_id,is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [next.id, sub.client_id]);
    let cashOpId = null;
    if (price > 0) cashOpId = await recordCashIn({ category: 'sale_subscription', amount: price, method: b.method || 'cash', ref_type: 'subscription', ref_id: next.id, description: `Продовження абонемента ${number} (${plan.name})`, ext_ref: `sub:renew:${next.id}` }).catch(() => null);
    await pool.query(`INSERT INTO subscription_payments (subscription_id,amount,period_start,period_end,status,payment_method,cashbox_op_id,notes) VALUES ($1,$2,$3,$4,'paid',$5,$6,'renew')`, [next.id, price, start, expires, b.method || 'cash', cashOpId]).catch(() => {});
    logAction({ user: req.user, action: 'subscription.renew', entity: 'subscription', entity_id: next.id, ip: req.ip, meta: { from: sub.id, carry } }).catch(() => {});
    res.json({ ok: true, subscription: next, carried_over: carry });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/upgrade — апгрейд/даунгрейд плану (перерахунок, перенесення остатку)
router.post('/:id/upgrade', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    if (!b.new_plan_id) return res.status(400).json({ error: 'new_plan_id required' });
    let sub = (await pool.query(`SELECT s.*, p.price AS old_price FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [id])).rows[0];
    if (!sub) return res.status(404).json({ error: 'not found' });
    sub = await refreshExpiry(sub);
    if (!['active', 'trial', 'frozen', 'grace_period'].includes(sub.status)) return res.status(409).json({ error: 'not-upgradable', status: sub.status });
    const np = (await pool.query(`SELECT * FROM subscription_plans WHERE id=$1`, [+b.new_plan_id])).rows[0];
    if (!np) return res.status(404).json({ error: 'new plan not found' });
    if (!np.active) return res.status(409).json({ error: 'new plan inactive' });
    const start = kyivToday();
    const expires = addDays(start, np.duration_days || 365);
    const number = await genNumber();
    // Перенесення остатку: visits → visits, інакше з нуля по новому плану.
    let visitsRem = ['visits', 'combo'].includes(np.type) ? np.visits_included : null;
    if (['visits', 'combo'].includes(np.type) && Number(sub.visits_remaining) > 0) visitsRem = Number(np.visits_included || 0) + Number(sub.visits_remaining);
    const minutesRem = np.type === 'minutes' ? (Number(np.minutes_included || 0) + (Number(sub.minutes_remaining) || 0)) : null;
    // Перерахунок: різниця цін (доплата при апгрейді; даунгрейд = 0, без повернення тут).
    const diff = Math.max(0, Number(np.price) - Number(sub.old_price));
    const ins = await pool.query(
      `INSERT INTO subscriptions
        (plan_id,client_id,branch_id,subscription_number,status,visits_remaining,minutes_remaining,started_at,expires_at,
         auto_renew,payment_method,renewed_from_id,sold_by,notes)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [np.id, sub.client_id, sub.branch_id, number, visitsRem, minutesRem, start, expires,
       sub.auto_renew, sub.payment_method || 'cash', sub.id, req.user?.display_name || null, b.notes || null]);
    const next = ins.rows[0];
    await pool.query(`INSERT INTO subscription_users (subscription_id,client_id,is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [next.id, sub.client_id]);
    // Старий абонемент закриваємо, фіксуємо звʼязок.
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=NOW(), cancel_reason='upgrade', upgraded_to_id=$1, updated_at=NOW() WHERE id=$2`, [next.id, sub.id]);
    let cashOpId = null;
    if (diff > 0) cashOpId = await recordCashIn({ category: 'sale_subscription', amount: diff, method: b.method || 'cash', ref_type: 'subscription', ref_id: next.id, description: `Апгрейд абонемента ${number} (${np.name}), доплата`, ext_ref: `sub:upgrade:${next.id}` }).catch(() => null);
    await pool.query(`INSERT INTO subscription_payments (subscription_id,amount,period_start,period_end,status,payment_method,cashbox_op_id,notes) VALUES ($1,$2,$3,$4,'paid',$5,$6,'upgrade')`, [next.id, diff, start, expires, b.method || 'cash', cashOpId]).catch(() => {});
    logAction({ user: req.user, action: 'subscription.upgrade', entity: 'subscription', entity_id: next.id, ip: req.ip, meta: { from: sub.id, new_plan: np.id, diff } }).catch(() => {});
    res.json({ ok: true, subscription: next, surcharge: diff });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/notify — позначити надіслане нагадування (renewal | expiry) для COM-01
router.post('/:id/notify', async (req, res) => {
  try {
    const kind = req.body?.kind === 'renewal' ? 'renewal' : 'expiry';
    const col = kind === 'renewal' ? 'renewal_notified_at' : 'expiry_notified_at';
    const upd = (await pool.query(`UPDATE subscriptions SET ${col}=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id, ${col}`, [+req.params.id])).rows[0];
    if (!upd) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, kind, notified_at: upd[col] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
