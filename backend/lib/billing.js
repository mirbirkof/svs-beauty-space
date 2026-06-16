/* lib/billing.js — SAS-03 Billing.
   Платформенный биллинг тенантов: подписки, счета (INV-YYYY-NNNNNN), платежи,
   методы оплаты, промокоды (percent/fixed), dunning (4 попытки), recurring billing,
   prorated upgrade/downgrade, метрики MRR/ARR/churn для SAS-07.
   Платёжный шлюз pluggable: 'manual' (офлайн-оплата) работает сразу; stripe/liqpay/
   monobank активируются ключами (без ключа charge() кидает gateway-not-configured).
   Таблицы без RLS (как saas_plans) — tenant-facing фильтрует по tenant_id явно. */
const { getPool } = require('../db-pg');

const CYCLES = { monthly: 'price_month', yearly: 'price_year' };
const PERIOD_DAYS = { monthly: 30, yearly: 365 };
const TRIAL_DAYS = 14;
const DUNNING_OFFSETS_H = [0, 24, 72, 168]; // попытки: сразу, +1д, +3д, +7д

// ── Платёжные шлюзы (pluggable) ──────────────────────────────────────
// charge возвращает {status:'succeeded'|'failed', gateway_payment_id, raw}.
// 'manual' = офлайн-оплата (банковский перевод): счёт остаётся open, оплата вручную.
const GATEWAYS = {
  manual: {
    configured: () => true,
    async charge() { return { status: 'pending', gateway_payment_id: null, raw: { mode: 'offline' } }; },
    async refund() { return { status: 'refunded', raw: { mode: 'offline' } }; },
  },
  stripe: gatewayStub('STRIPE_SECRET_KEY'),
  liqpay: gatewayStub('LIQPAY_PRIVATE_KEY'),
  monobank: gatewayStub('MONOBANK_TOKEN'),
};
function gatewayStub(envKey) {
  return {
    configured: () => !!process.env[envKey],
    async charge() { throw new Error('gateway-not-configured'); },
    async refund() { throw new Error('gateway-not-configured'); },
  };
}
function gateway(name) { return GATEWAYS[name] || GATEWAYS.manual; }
function gatewayStatus() {
  return Object.fromEntries(Object.entries(GATEWAYS).map(([k, g]) => [k, g.configured()]));
}

// ── Цены / номера ────────────────────────────────────────────────────
async function planPrice(planCode, cycle = 'monthly') {
  const col = CYCLES[cycle] || 'price_month';
  const r = (await getPool().query(`SELECT ${col} AS price FROM saas_plans WHERE code=$1`, [planCode])).rows[0];
  if (!r) throw new Error('plan-not-found');
  return Number(r.price) || 0;
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const n = Number((await getPool().query(
    `SELECT count(*)::int n FROM invoices_saas WHERE invoice_number LIKE $1`, [`INV-${year}-%`])).rows[0].n) + 1;
  return `INV-${year}-${String(n).padStart(6, '0')}`;
}

// ── Промокоды ────────────────────────────────────────────────────────
async function validatePromo(code, planCode = null) {
  const p = (await getPool().query(`SELECT * FROM promo_codes_saas WHERE code=$1`, [code])).rows[0];
  if (!p) return { valid: false, reason: 'not-found' };
  const now = new Date();
  if (!p.is_active) return { valid: false, reason: 'inactive' };
  if (p.valid_from && new Date(p.valid_from) > now) return { valid: false, reason: 'not-started' };
  if (p.valid_until && new Date(p.valid_until) < now) return { valid: false, reason: 'expired' };
  if (p.max_uses != null && p.times_used >= p.max_uses) return { valid: false, reason: 'exhausted' };
  if (planCode && Array.isArray(p.applicable_plans) && p.applicable_plans.length && !p.applicable_plans.includes(planCode))
    return { valid: false, reason: 'plan-not-applicable' };
  return { valid: true, promo: p, discount_type: p.discount_type, discount_value: Number(p.discount_value) };
}

function applyDiscount(amount, promo) {
  if (!promo) return { discount: 0, total: amount };
  const v = Number(promo.discount_value) || 0;
  const discount = promo.discount_type === 'percent'
    ? Math.round(amount * Math.min(v, 100)) / 100
    : Math.min(v, amount);
  return { discount: Math.round(discount * 100) / 100, total: Math.round((amount - discount) * 100) / 100 };
}

// ── Подписка ─────────────────────────────────────────────────────────
async function getSubscription(tenantId) {
  return (await getPool().query(`SELECT * FROM subscriptions_saas WHERE tenant_id=$1`, [tenantId])).rows[0] || null;
}

// Создать/перезапустить подписку. Trial по умолчанию (14д), затем первый счёт.
async function createSubscription(tenantId, { plan_code, cycle = 'monthly', promo_code = null, gateway: gw = 'manual', trial = true } = {}, user = null) {
  if (!plan_code) throw new Error('plan_code-required');
  await planPrice(plan_code, cycle); // валидация плана/цикла
  const pool = getPool();
  let promoId = null;
  if (promo_code) { const v = await validatePromo(promo_code, plan_code); if (!v.valid) throw new Error('promo-' + v.reason); promoId = v.promo.id; }
  const days = PERIOD_DAYS[cycle] || 30;
  const status = trial ? 'trialing' : 'active';
  const sub = (await pool.query(
    `INSERT INTO subscriptions_saas (tenant_id, plan_code, status, billing_cycle, current_period_start,
       current_period_end, trial_ends_at, payment_gateway, promo_code_id)
     VALUES ($1,$2,$3,$4,NOW(), NOW()+($5||' days')::interval, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET plan_code=EXCLUDED.plan_code, status=EXCLUDED.status,
       billing_cycle=EXCLUDED.billing_cycle, current_period_start=NOW(),
       current_period_end=EXCLUDED.current_period_end, trial_ends_at=EXCLUDED.trial_ends_at,
       payment_gateway=EXCLUDED.payment_gateway, promo_code_id=EXCLUDED.promo_code_id,
       cancelled_at=NULL, cancel_reason=NULL, cancel_at_period_end=FALSE, updated_at=NOW()
     RETURNING *`,
    [tenantId, plan_code, status, cycle, trial ? TRIAL_DAYS : days, trial ? new Date(Date.now() + TRIAL_DAYS * 864e5) : null, gw, promoId])).rows[0];
  // зеркалим в tenant_licenses (источник для feature-gating)
  await syncLicense(tenantId, plan_code, status, sub.current_period_end).catch(() => {});
  if (!trial) await generateInvoice(sub, { promoId }).catch(e => console.error('[billing] invoice', e.message));
  return sub;
}

// Смена тарифа (prorated). Возвращает {subscription, proration}.
async function changePlan(tenantId, plan_code, cycle = null) {
  const sub = await getSubscription(tenantId);
  if (!sub) throw new Error('subscription-not-found');
  const newCycle = cycle || sub.billing_cycle;
  const oldPrice = await planPrice(sub.plan_code, sub.billing_cycle);
  const newPrice = await planPrice(plan_code, newCycle);
  // пропорция за остаток периода
  const now = Date.now();
  const start = new Date(sub.current_period_start).getTime();
  const end = new Date(sub.current_period_end).getTime();
  const totalMs = Math.max(1, end - start);
  const remainFrac = Math.max(0, Math.min(1, (end - now) / totalMs));
  const credit = Math.round(oldPrice * remainFrac * 100) / 100;       // неиспользованный остаток старого
  const charge = Math.round(newPrice * remainFrac * 100) / 100;       // новый за остаток
  const proration = Math.round((charge - credit) * 100) / 100;        // к доплате (может быть <0 = кредит)
  const pool = getPool();
  const updated = (await pool.query(
    `UPDATE subscriptions_saas SET plan_code=$2, billing_cycle=$3, updated_at=NOW()
     WHERE tenant_id=$1 RETURNING *`, [tenantId, plan_code, newCycle])).rows[0];
  await syncLicense(tenantId, plan_code, updated.status, updated.current_period_end).catch(() => {});
  // доплата → отдельный счёт
  if (proration > 0) {
    await createInvoiceRow(updated, {
      subtotal: proration, discount: 0, total: proration,
      lineItems: [{ description: `Зміна тарифу ${sub.plan_code}→${plan_code} (пропорційно)`, amount: proration, qty: 1 }],
      status: 'open',
    });
  }
  return { subscription: updated, proration };
}

async function cancelSubscription(tenantId, { reason = null, immediate = false } = {}) {
  const sub = await getSubscription(tenantId);
  if (!sub) throw new Error('subscription-not-found');
  const pool = getPool();
  const upd = immediate
    ? (await pool.query(
        `UPDATE subscriptions_saas SET status='cancelled', cancelled_at=NOW(), cancel_reason=$2,
           cancel_at_period_end=FALSE, current_period_end=NOW(), updated_at=NOW()
         WHERE tenant_id=$1 RETURNING *`, [tenantId, reason])).rows[0]
    : (await pool.query(
        `UPDATE subscriptions_saas SET cancel_at_period_end=TRUE, cancel_reason=$2, updated_at=NOW()
         WHERE tenant_id=$1 RETURNING *`, [tenantId, reason])).rows[0];
  if (immediate) await syncLicense(tenantId, sub.plan_code, 'cancelled', upd.current_period_end).catch(() => {});
  return upd;
}

async function resumeSubscription(tenantId) {
  const sub = await getSubscription(tenantId);
  if (!sub) throw new Error('subscription-not-found');
  if (sub.status === 'cancelled' && new Date(sub.current_period_end) < new Date()) throw new Error('subscription-expired');
  return (await getPool().query(
    `UPDATE subscriptions_saas SET cancel_at_period_end=FALSE, cancel_reason=NULL,
       status=CASE WHEN status='cancelled' THEN 'active' ELSE status END, cancelled_at=NULL, updated_at=NOW()
     WHERE tenant_id=$1 RETURNING *`, [tenantId])).rows[0];
}

// Зеркалирование подписки в tenant_licenses (feature-gating читает оттуда).
async function syncLicense(tenantId, planCode, status, expiresAt) {
  const licStatus = status === 'active' || status === 'trialing' ? 'active' : status;
  await getPool().query(
    `INSERT INTO tenant_licenses (tenant_id, plan_code, status, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET plan_code=EXCLUDED.plan_code, status=EXCLUDED.status,
       expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [tenantId, planCode, licStatus, expiresAt]);
}

// ── Счета ────────────────────────────────────────────────────────────
async function createInvoiceRow(sub, { subtotal, discount = 0, tax = 0, total, lineItems = [], status = 'open', periodStart = null, periodEnd = null }) {
  const num = await nextInvoiceNumber();
  return (await getPool().query(
    `INSERT INTO invoices_saas (tenant_id, subscription_id, invoice_number, status, subtotal,
       discount_amount, tax_amount, total, period_start, period_end, line_items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [sub.tenant_id, sub.id, num, status, subtotal, discount, tax, total,
     periodStart || sub.current_period_start, periodEnd || sub.current_period_end, JSON.stringify(lineItems)])).rows[0];
}

// Счёт за период подписки (с учётом промокода).
async function generateInvoice(sub, { promoId = null } = {}) {
  const price = await planPrice(sub.plan_code, sub.billing_cycle);
  let promo = null;
  const pid = promoId || sub.promo_code_id;
  if (pid) promo = (await getPool().query(`SELECT * FROM promo_codes_saas WHERE id=$1`, [pid])).rows[0] || null;
  const { discount, total } = applyDiscount(price, promo);
  const inv = await createInvoiceRow(sub, {
    subtotal: price, discount, total, status: 'open',
    lineItems: [{ description: `${sub.plan_code} (${sub.billing_cycle})`, amount: price, qty: 1 }],
  });
  if (promo && discount > 0) await getPool().query(
    `UPDATE promo_codes_saas SET times_used=times_used+1, updated_at=NOW() WHERE id=$1`, [promo.id]).catch(() => {});
  return inv;
}

async function listInvoices({ tenantId = null, status = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
  const where = [], params = []; let i = 1;
  if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
  if (status) { where.push(`status=$${i++}`); params.push(status); }
  if (from) { where.push(`created_at>=$${i++}`); params.push(from); }
  if (to) { where.push(`created_at<=$${i++}`); params.push(to); }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const rows = (await getPool().query(
    `SELECT * FROM invoices_saas ${ws} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows;
  return { rows };
}

async function getInvoice(id, tenantId = null) {
  const inv = (await getPool().query(`SELECT * FROM invoices_saas WHERE id=$1`, [id])).rows[0];
  if (!inv) return null;
  if (tenantId && String(inv.tenant_id) !== String(tenantId)) return null;
  const payments = (await getPool().query(`SELECT * FROM payments_saas WHERE invoice_id=$1 ORDER BY created_at`, [id])).rows;
  return { invoice: inv, payments };
}

async function voidInvoice(id) {
  return (await getPool().query(
    `UPDATE invoices_saas SET status='void', updated_at=NOW() WHERE id=$1 AND status NOT IN ('paid') RETURNING *`, [id])).rows[0] || null;
}

// ── Платежи ──────────────────────────────────────────────────────────
// Зафиксировать платёж по счёту. status='succeeded' → счёт paid + подписка active.
async function recordPayment(invoiceId, { amount = null, gateway: gw = 'manual', methodId = null, status = 'succeeded', gatewayPaymentId = null, raw = null } = {}) {
  const pool = getPool();
  const inv = (await pool.query(`SELECT * FROM invoices_saas WHERE id=$1`, [invoiceId])).rows[0];
  if (!inv) throw new Error('invoice-not-found');
  const amt = amount != null ? amount : Number(inv.total);
  const pay = (await pool.query(
    `INSERT INTO payments_saas (tenant_id, invoice_id, payment_method_id, amount, status, gateway, gateway_payment_id, gateway_response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [inv.tenant_id, invoiceId, methodId, amt, status, gw, gatewayPaymentId, raw ? JSON.stringify(raw) : null])).rows[0];
  if (status === 'succeeded') {
    await pool.query(`UPDATE invoices_saas SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1`, [invoiceId]);
    if (inv.subscription_id) {
      const sub = (await pool.query(
        `UPDATE subscriptions_saas SET status='active', updated_at=NOW() WHERE id=$1 RETURNING *`, [inv.subscription_id])).rows[0];
      if (sub) await syncLicense(sub.tenant_id, sub.plan_code, 'active', sub.current_period_end).catch(() => {});
      // снять dunning
      await pool.query(`UPDATE dunning_attempts SET status='succeeded' WHERE invoice_id=$1 AND status='pending'`, [invoiceId]).catch(() => {});
    }
  }
  return pay;
}

async function listPayments({ tenantId = null, limit = 50, offset = 0 } = {}) {
  const where = [], params = []; let i = 1;
  if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  return { rows: (await getPool().query(
    `SELECT * FROM payments_saas ${ws} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows };
}

async function refundPayment(id, amount = null) {
  const pool = getPool();
  const p = (await pool.query(`SELECT * FROM payments_saas WHERE id=$1`, [id])).rows[0];
  if (!p) throw new Error('payment-not-found');
  if (p.status !== 'succeeded' && p.status !== 'partially_refunded') throw new Error('payment-not-refundable');
  const amt = amount != null ? Number(amount) : Number(p.amount) - Number(p.refunded_amount);
  const g = gateway(p.gateway);
  let raw = { mode: 'manual' };
  try { raw = (await g.refund(p, amt)).raw || raw; } catch (e) { if (p.gateway !== 'manual') throw e; }
  const newRefunded = Number(p.refunded_amount) + amt;
  const status = newRefunded >= Number(p.amount) ? 'refunded' : 'partially_refunded';
  return (await pool.query(
    `UPDATE payments_saas SET refunded_amount=$2, status=$3, gateway_response=$4, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, newRefunded, status, JSON.stringify(raw)])).rows[0];
}

// ── Методы оплаты ────────────────────────────────────────────────────
async function listPaymentMethods(tenantId) {
  return (await getPool().query(
    `SELECT id, tenant_id, type, gateway, last4, brand, exp_month, exp_year, is_default, created_at
       FROM payment_methods WHERE tenant_id=$1 ORDER BY is_default DESC, created_at DESC`, [tenantId])).rows;
}

async function addPaymentMethod(tenantId, { type = 'card', gateway: gw = 'manual', token, last4 = null, brand = null, exp_month = null, exp_year = null, makeDefault = false } = {}) {
  if (!token) throw new Error('token-required');
  const pool = getPool();
  const count = Number((await pool.query(`SELECT count(*)::int n FROM payment_methods WHERE tenant_id=$1`, [tenantId])).rows[0].n);
  const isDefault = makeDefault || count === 0;
  if (isDefault) await pool.query(`UPDATE payment_methods SET is_default=FALSE WHERE tenant_id=$1`, [tenantId]);
  return (await pool.query(
    `INSERT INTO payment_methods (tenant_id, type, gateway, gateway_token, last4, brand, exp_month, exp_year, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, tenant_id, type, gateway, last4, brand, is_default`,
    [tenantId, type, gw, token, last4, brand, exp_month, exp_year, isDefault])).rows[0];
}

async function removePaymentMethod(tenantId, id) {
  const r = (await getPool().query(`DELETE FROM payment_methods WHERE id=$1 AND tenant_id=$2 RETURNING is_default`, [id, tenantId])).rows[0];
  if (!r) throw new Error('method-not-found');
  if (r.is_default) await getPool().query(
    `UPDATE payment_methods SET is_default=TRUE WHERE id=(SELECT id FROM payment_methods WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1)`, [tenantId]);
  return { ok: true };
}

async function setDefaultPaymentMethod(tenantId, id) {
  const pool = getPool();
  const exists = (await pool.query(`SELECT id FROM payment_methods WHERE id=$1 AND tenant_id=$2`, [id, tenantId])).rows[0];
  if (!exists) throw new Error('method-not-found');
  await pool.query(`UPDATE payment_methods SET is_default=FALSE WHERE tenant_id=$1`, [tenantId]);
  return (await pool.query(`UPDATE payment_methods SET is_default=TRUE WHERE id=$1 RETURNING id, is_default`, [id])).rows[0];
}

// ── Промокоды CRUD ───────────────────────────────────────────────────
async function listPromoCodes({ active = null, limit = 50, offset = 0 } = {}) {
  const where = [], params = []; let i = 1;
  if (active != null) { where.push(`is_active=$${i++}`); params.push(active); }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  return { rows: (await getPool().query(
    `SELECT * FROM promo_codes_saas ${ws} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows };
}

async function createPromoCode(b = {}, user = null) {
  if (!b.code || b.discount_value == null) throw new Error('code-and-value-required');
  return (await getPool().query(
    `INSERT INTO promo_codes_saas (code, description, discount_type, discount_value, currency, max_uses, valid_from, valid_until, applicable_plans, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()),$8,$9,COALESCE($10,true),$11)
     ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description, discount_type=EXCLUDED.discount_type,
       discount_value=EXCLUDED.discount_value, max_uses=EXCLUDED.max_uses, valid_until=EXCLUDED.valid_until,
       applicable_plans=EXCLUDED.applicable_plans, is_active=EXCLUDED.is_active, updated_at=NOW() RETURNING *`,
    [b.code, b.description || null, b.discount_type || 'percent', b.discount_value, b.currency || 'UAH',
     b.max_uses ?? null, b.valid_from || null, b.valid_until || null, b.applicable_plans || [], b.is_active, user?.id || null])).rows[0];
}

async function updatePromoCode(id, patch = {}) {
  const cols = [], vals = []; let i = 1;
  for (const k of ['description', 'discount_type', 'discount_value', 'max_uses', 'valid_until', 'is_active', 'applicable_plans']) {
    if (patch[k] !== undefined) { cols.push(`${k}=$${i++}`); vals.push(patch[k]); }
  }
  if (!cols.length) return null;
  cols.push('updated_at=NOW()'); vals.push(id);
  return (await getPool().query(`UPDATE promo_codes_saas SET ${cols.join(', ')} WHERE id=$${i} RETURNING *`, vals)).rows[0] || null;
}

async function deletePromoCode(id) {
  return (await getPool().query(`UPDATE promo_codes_saas SET is_active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`, [id])).rows[0] || null;
}

// ── Dunning ──────────────────────────────────────────────────────────
// Запланировать серию из 4 попыток для просроченного счёта.
async function scheduleDunning(subscriptionId, invoiceId) {
  const pool = getPool();
  const exists = Number((await pool.query(
    `SELECT count(*)::int n FROM dunning_attempts WHERE invoice_id=$1 AND status IN ('pending','attempted')`, [invoiceId])).rows[0].n);
  if (exists > 0) return { scheduled: 0 };
  let scheduled = 0;
  for (let k = 0; k < DUNNING_OFFSETS_H.length; k++) {
    await pool.query(
      `INSERT INTO dunning_attempts (subscription_id, invoice_id, attempt_number, scheduled_at)
       VALUES ($1,$2,$3, NOW()+($4||' hours')::interval)`,
      [subscriptionId, invoiceId, k + 1, DUNNING_OFFSETS_H[k]]);
    scheduled++;
  }
  await pool.query(`UPDATE subscriptions_saas SET status='past_due', updated_at=NOW() WHERE id=$1 AND status='active'`, [subscriptionId]);
  return { scheduled };
}

// Прогнать готовые попытки dunning (cron). manual-шлюз: только уведомление, без авто-charge.
async function processDunning(limit = 100) {
  const pool = getPool();
  const due = (await pool.query(
    `SELECT d.*, s.tenant_id, s.payment_gateway, i.total, i.status AS inv_status
       FROM dunning_attempts d
       JOIN subscriptions_saas s ON s.id=d.subscription_id
       JOIN invoices_saas i ON i.id=d.invoice_id
      WHERE d.status='pending' AND d.scheduled_at<=NOW()
      ORDER BY d.scheduled_at LIMIT $1`, [limit])).rows;
  let attempted = 0, recovered = 0, suspended = 0;
  for (const d of due) {
    if (d.inv_status === 'paid') { await pool.query(`UPDATE dunning_attempts SET status='succeeded' WHERE id=$1`, [d.id]); continue; }
    const g = gateway(d.payment_gateway);
    let result = { status: 'failed', raw: null };
    if (d.payment_gateway !== 'manual' && g.configured()) {
      try { result = await g.charge({ tenantId: d.tenant_id, amount: Number(d.total) }); } catch (e) { result = { status: 'failed', raw: { error: e.message } }; }
    }
    attempted++;
    if (result.status === 'succeeded') {
      await recordPayment(d.invoice_id, { gateway: d.payment_gateway, status: 'succeeded', gatewayPaymentId: result.gateway_payment_id, raw: result.raw });
      await pool.query(`UPDATE dunning_attempts SET status='succeeded', attempted_at=NOW(), gateway_response=$2 WHERE id=$1`,
        [d.id, JSON.stringify(result.raw)]);
      recovered++;
    } else {
      await pool.query(`UPDATE dunning_attempts SET status='attempted', attempted_at=NOW(), notification_sent=TRUE, notification_type='email', gateway_response=$2 WHERE id=$1`,
        [d.id, result.raw ? JSON.stringify(result.raw) : null]);
      // последняя попытка провалена → suspend
      if (d.attempt_number >= DUNNING_OFFSETS_H.length) {
        await pool.query(`UPDATE subscriptions_saas SET status='suspended', updated_at=NOW() WHERE id=$1`, [d.subscription_id]);
        await pool.query(`UPDATE tenants SET status='suspended', updated_at=NOW() WHERE id=$1`, [d.tenant_id]).catch(() => {});
        suspended++;
      }
    }
  }
  return { due: due.length, attempted, recovered, suspended };
}

// ── Recurring billing (cron) ─────────────────────────────────────────
// Завершить периоды: trial→счёт, активные с истёкшим периодом→продление+счёт, cancel_at_period_end→cancelled.
async function runRecurring(limit = 200) {
  const pool = getPool();
  const due = (await pool.query(
    `SELECT * FROM subscriptions_saas
      WHERE current_period_end<=NOW() AND status IN ('trialing','active')
      ORDER BY current_period_end LIMIT $1`, [limit])).rows;
  let renewed = 0, cancelled = 0, invoiced = 0;
  for (const sub of due) {
    if (sub.cancel_at_period_end) {
      await pool.query(`UPDATE subscriptions_saas SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`, [sub.id]);
      await syncLicense(sub.tenant_id, sub.plan_code, 'cancelled', sub.current_period_end).catch(() => {});
      cancelled++; continue;
    }
    const days = PERIOD_DAYS[sub.billing_cycle] || 30;
    const renewedSub = (await pool.query(
      `UPDATE subscriptions_saas SET current_period_start=current_period_end,
         current_period_end=current_period_end+($2||' days')::interval, status='active', updated_at=NOW()
       WHERE id=$1 RETURNING *`, [sub.id, days])).rows[0];
    renewed++;
    const inv = await generateInvoice(renewedSub).catch(e => { console.error('[billing] renew invoice', e.message); return null; });
    if (inv) {
      invoiced++;
      // авто-charge если шлюз настроен, иначе dunning (manual = ожидание оплаты)
      const g = gateway(renewedSub.payment_gateway);
      if (renewedSub.payment_gateway !== 'manual' && g.configured()) {
        try {
          const r = await g.charge({ tenantId: sub.tenant_id, amount: Number(inv.total) });
          if (r.status === 'succeeded') await recordPayment(inv.id, { gateway: renewedSub.payment_gateway, status: 'succeeded', gatewayPaymentId: r.gateway_payment_id, raw: r.raw });
          else await scheduleDunning(renewedSub.id, inv.id);
        } catch { await scheduleDunning(renewedSub.id, inv.id); }
      }
    }
  }
  return { due: due.length, renewed, cancelled, invoiced };
}

// ── Метрики (для SAS-07) ─────────────────────────────────────────────
async function billingMetrics() {
  const pool = getPool();
  // MRR: сумма месячного эквивалента активных подписок
  const subs = (await pool.query(
    `SELECT s.plan_code, s.billing_cycle, p.price_month, p.price_year
       FROM subscriptions_saas s JOIN saas_plans p ON p.code=s.plan_code
      WHERE s.status IN ('active','trialing')`)).rows;
  let mrr = 0;
  for (const s of subs) mrr += s.billing_cycle === 'yearly' ? Number(s.price_year) / 12 : Number(s.price_month);
  mrr = Math.round(mrr * 100) / 100;
  const byStatus = (await pool.query(`SELECT status, count(*)::int n FROM subscriptions_saas GROUP BY status`)).rows;
  const st = {}; byStatus.forEach(r => st[r.status] = r.n);
  const active = (st.active || 0) + (st.trialing || 0);
  const cancelled30 = Number((await pool.query(
    `SELECT count(*)::int n FROM subscriptions_saas WHERE status='cancelled' AND cancelled_at>=NOW()-INTERVAL '30 days'`)).rows[0].n);
  const churn = active + cancelled30 > 0 ? Math.round((cancelled30 / (active + cancelled30)) * 1000) / 10 : 0;
  const revenue30 = Number((await pool.query(
    `SELECT COALESCE(SUM(amount),0) s FROM payments_saas WHERE status='succeeded' AND created_at>=NOW()-INTERVAL '30 days'`)).rows[0].s);
  const outstanding = Number((await pool.query(
    `SELECT COALESCE(SUM(total),0) s FROM invoices_saas WHERE status='open'`)).rows[0].s);
  return {
    mrr, arr: Math.round(mrr * 12 * 100) / 100, active_subscriptions: active,
    by_status: st, churn_rate_30d: churn, revenue_30d: Math.round(revenue30 * 100) / 100,
    outstanding_open: Math.round(outstanding * 100) / 100,
  };
}

module.exports = {
  // gateways
  gatewayStatus,
  // pricing/promo
  planPrice, nextInvoiceNumber, validatePromo, applyDiscount,
  // subscription
  getSubscription, createSubscription, changePlan, cancelSubscription, resumeSubscription,
  // invoices
  generateInvoice, listInvoices, getInvoice, voidInvoice,
  // payments
  recordPayment, listPayments, refundPayment,
  // methods
  listPaymentMethods, addPaymentMethod, removePaymentMethod, setDefaultPaymentMethod,
  // promo crud
  listPromoCodes, createPromoCode, updatePromoCode, deletePromoCode,
  // dunning / recurring / metrics
  scheduleDunning, processDunning, runRecurring, billingMetrics,
};
