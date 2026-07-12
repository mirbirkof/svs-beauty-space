/* lib/billing.js — SAS-03 Billing.
   Платформенный биллинг тенантов: подписки, счета (INV-YYYY-NNNNNN), платежи,
   методы оплаты, промокоды (percent/fixed), dunning (4 попытки), recurring billing,
   prorated upgrade/downgrade, метрики MRR/ARR/churn для SAS-07.
   Платёжный шлюз pluggable: 'manual' (офлайн-оплата) работает сразу; stripe/liqpay/
   monobank активируются ключами (без ключа charge() кидает gateway-not-configured).
   Таблицы без RLS (как saas_plans) — tenant-facing фильтрует по tenant_id явно. */
const { getPool } = require('../db-pg');

// Сбросить кэш статуса салона после смены tenants.status (оплата/блокировка),
// иначе вход остаётся в старом статусе до 5 мин. Ленивый require — tenant.js
// тоже тянет db-pg; цикла нет (tenant.js не зависит от billing).
function _invalidateTenantCache(id) {
  if (!id) return;
  try { require('./tenant').invalidateTenant({ id }); } catch { /* в тестах без middleware */ }
}

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
  // Mono — оплата за посиланням (без збереженої картки): авто-charge неможливий,
  // рахунок підписки оплачується через pay-link (createSubscriptionPayLink) + вебхук.
  monobank: {
    configured: () => !!process.env.MONO_TOKEN,
    async charge() { return { status: 'pending', gateway_payment_id: null, raw: { mode: 'mono-link' } }; },
    async refund() { return { status: 'refunded', raw: { mode: 'mono-manual' } }; },
  },
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
// Каноническая таблица тарифов — saas_plans_v2 (мультивалюта, тиры, триалы). Старые коды
// (solo/pro) маппятся на новые слаги — тем же словарём, что feature-gate (единая истина).
// Аудит: раньше planPrice читал старую saas_plans, а feature-gate — v2 → биллинг не находил
// тариф 'professional' (в старой он 'pro') и счёт на платный план не выставлялся.
const LEGACY_SLUG = { solo: 'free', pro: 'professional' };
const CYCLES_V2 = { monthly: 'price_monthly_uah', yearly: 'price_yearly_uah' };
async function planPrice(planCode, cycle = 'monthly') {
  const slug = LEGACY_SLUG[planCode] || planCode;
  const colV2 = CYCLES_V2[cycle] || 'price_monthly_uah';
  const v2 = (await getPool().query(`SELECT ${colV2} AS price FROM saas_plans_v2 WHERE slug=$1`, [slug])).rows[0];
  if (v2) return Number(v2.price) || 0;
  // fallback на legacy-таблицу (план ещё не перенесён в v2)
  const col = CYCLES[cycle] || 'price_month';
  const r = (await getPool().query(`SELECT ${col} AS price FROM saas_plans WHERE code=$1`, [planCode])).rows[0];
  if (!r) throw new Error('plan-not-found');
  return Number(r.price) || 0;
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  // Аудит v6: count(*)+1 не атомарен — два конкурентных счёта получали один номер,
  // второй падал об UNIQUE без ретрая. Sequence (мигр. 254) выдаёт номер атомарно.
  try {
    const n = Number((await getPool().query(`SELECT nextval('invoice_number_seq') AS n`)).rows[0].n);
    return `INV-${year}-${String(n).padStart(6, '0')}`;
  } catch (_) {
    // sequence ещё не создана (254 не накатана) — старый путь как fallback
    const n = Number((await getPool().query(
      `SELECT count(*)::int n FROM invoices_saas WHERE invoice_number LIKE $1`, [`INV-${year}-%`])).rows[0].n) + 1;
    return `INV-${year}-${String(n).padStart(6, '0')}`;
  }
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
  // Аудит v6: триал давался при КАЖДОМ вызове (ON CONFLICT перезаписывал trial_ends_at) —
  // владелец мог бесконечно сбрасывать себе 14 дней и не платить никогда. Триал — один раз.
  if (trial) {
    const prev = (await pool.query(
      `SELECT trial_ends_at FROM subscriptions_saas WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (prev && prev.trial_ends_at) trial = false;
  }
  const days = PERIOD_DAYS[cycle] || 30;
  const status = trial ? 'trialing' : 'active';
  const sub = (await pool.query(
    `INSERT INTO subscriptions_saas (tenant_id, plan_code, status, billing_cycle, current_period_start,
       current_period_end, trial_ends_at, payment_gateway, promo_code_id)
     VALUES ($1,$2,$3,$4,NOW(), NOW()+($5||' days')::interval, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET plan_code=EXCLUDED.plan_code, status=EXCLUDED.status,
       billing_cycle=EXCLUDED.billing_cycle, current_period_start=NOW(),
       current_period_end=EXCLUDED.current_period_end,
       -- НЕ затираем факт использованного триала: при смене плана (trial=false → EXCLUDED=null)
       -- сохраняем прежний trial_ends_at, иначе одноразовость триала сбрасывается (регресс).
       trial_ends_at=COALESCE(EXCLUDED.trial_ends_at, subscriptions_saas.trial_ends_at),
       payment_gateway=EXCLUDED.payment_gateway, promo_code_id=EXCLUDED.promo_code_id,
       cancelled_at=NULL, cancel_reason=NULL, cancel_at_period_end=FALSE, updated_at=NOW()
     RETURNING *`,
    [tenantId, plan_code, status, cycle, trial ? TRIAL_DAYS : days, trial ? new Date(Date.now() + TRIAL_DAYS * 864e5) : null, gw, promoId])).rows[0];
  // зеркалим в tenant_licenses (источник для feature-gating)
  await syncLicense(tenantId, plan_code, status, sub.current_period_end).catch(() => {});
  // Рахунок — лише для платних планів. Безкоштовні (solo/free, ціна 0) активні без рахунку.
  if (!trial) {
    const price = await planPrice(plan_code, cycle).catch(() => 0);
    if (Number(price) > 0) await generateInvoice(sub, { promoId }).catch(e => console.error('[billing] invoice', e.message));
  }
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
  // ПРЕСЕЙЛ-БЛОКЕР #4: рантайм-доступ к модулям (online_booking и др.) проверяется
  // isLicensed() ТОЛЬКО по таблице `licenses`, а не tenant_licenses. Регистрация кладёт
  // туда trial с expires_at=+14д, и оплата плана её НЕ продлевала → крон гасил онлайн-запись
  // у заплатившего салона через ~17 дней. Теперь при активной подписке конвертируем/продлеваем
  // строки `licenses` для всех модулей плана в subscription с датой конца периода подписки.
  if (licStatus === 'active') {
    try { await syncModuleLicenses(tenantId, planCode, expiresAt); }
    catch (e) { console.error('[billing] syncModuleLicenses failed:', e.message); }
  }
}

// Продлить/выдать строки в `licenses` для модулей, входящих в оплаченный план.
// saas_plans.features — JSONB-массив кодов; пересечение с module_catalog.code = модули
// под лицензией. '*' → все модули. expiresAt = конец текущего периода подписки: каждая
// оплата двигает его вперёд, при неоплате лицензия истекает штатно (крон + grace).
async function syncModuleLicenses(tenantId, planCode, expiresAt) {
  // saas_plans.features хранит старые коды планов → мапим новый slug на старый код,
  // иначе для 'professional' features не найдётся и модульные лицензии не выдадутся.
  const V2_TO_LEGACY = { professional: 'pro', free: 'free', enterprise: 'enterprise' };
  const legacyCode = V2_TO_LEGACY[planCode] || planCode;
  const pr = await getPool().query(`SELECT features FROM saas_plans WHERE code=$1`, [legacyCode]);
  if (!pr.rows.length) return;
  const feats = Array.isArray(pr.rows[0].features) ? pr.rows[0].features : [];
  const all = feats.includes('*');
  const mc = await getPool().query(`SELECT id, code FROM module_catalog`);
  const modules = mc.rows.filter(m => all || feats.includes(m.code));
  for (const m of modules) {
    await getPool().query(
      `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at, renewed_at)
       VALUES ($1,$2,'subscription','active',NOW(),$3,NOW())
       ON CONFLICT (tenant_id, module_id) WHERE status IN ('active','grace_period')
       DO UPDATE SET license_type='subscription', status='active',
         expires_at=EXCLUDED.expires_at, renewed_at=NOW(), updated_at=NOW()`,
      [tenantId, m.id, expiresAt || null]);
  }
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

// Сводка для баннера в кабинете салона: есть ли неоплаченные счета и насколько просрочены.
async function dueAlert(tenantId) {
  if (!tenantId) return { has_due: false };
  const rows = (await getPool().query(
    `SELECT id, invoice_number, total, currency, status, due_date, created_at
       FROM invoices_saas
      WHERE tenant_id=$1 AND status IN ('open','pending','overdue')
      ORDER BY COALESCE(due_date, created_at) ASC`, [tenantId])).rows;
  if (!rows.length) return { has_due: false };
  const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  const oldest = rows[0];
  const ref = oldest.due_date || oldest.created_at;
  const daysOverdue = ref ? Math.floor((Date.now() - new Date(ref).getTime()) / 86400000) : 0;
  // Салон заблоковано за несплату? (tenants.status='suspended' → доступ до CRM закритий)
  const tstatus = (await getPool().query(`SELECT status FROM tenants WHERE id=$1`, [tenantId])).rows[0]?.status || null;
  return {
    has_due: true,
    count: rows.length,
    total: Math.round(total * 100) / 100,
    currency: oldest.currency || 'UAH',
    invoice_id: oldest.id,
    invoice_number: oldest.invoice_number,
    status: oldest.status,
    days_overdue: daysOverdue > 0 ? daysOverdue : 0,
    blocked: tstatus === 'suspended',
  };
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
    // Аудит v6: частичная сумма (админ ввёл 50 из 100) помечала счёт полностью оплаченным.
    // Теперь paid — только когда сумма успешных платежей покрывает total.
    const paidSum = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM payments_saas WHERE invoice_id=$1 AND status='succeeded'`,
      [invoiceId])).rows[0].s);
    if (paidSum + 0.005 < Number(inv.total)) {
      console.log(`[billing] часткова оплата рахунку ${invoiceId}: ${paidSum}/${inv.total} — статус лишаємо`);
      return pay;
    }
    await pool.query(`UPDATE invoices_saas SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1`, [invoiceId]);
    if (inv.subscription_id) {
      const sub = (await pool.query(
        `UPDATE subscriptions_saas SET status='active', updated_at=NOW() WHERE id=$1 RETURNING *`, [inv.subscription_id])).rows[0];
      if (sub) {
        await syncLicense(sub.tenant_id, sub.plan_code, 'active', sub.current_period_end).catch(() => {});
        // Реактивировать сам салон: если он был suspended за неоплату, оплата
        // обязана его разблокировать (иначе остаётся заперт навсегда). + сброс кэша.
        await pool.query(`UPDATE tenants SET status='active', updated_at=NOW() WHERE id=$1 AND status<>'active'`, [sub.tenant_id]).catch(() => {});
        _invalidateTenantCache(sub.tenant_id);
        try { require('./feature-gate').invalidateFeatureCache(sub.tenant_id); } catch (_) {} // фічі вмикаються одразу після оплати
        // Партнёрська програма: перша оплата цього салону → нагорода рефереру (+днів підписки).
        // onReferredPaid сам перевіряє чи є pending-реферал і не нараховує двічі.
        try { await require('./partner-referrals').onReferredPaid(sub.tenant_id); } catch (e) { console.error('[billing:partner]', e.message); }
      }
      // снять dunning
      await pool.query(`UPDATE dunning_attempts SET status='succeeded' WHERE invoice_id=$1 AND status='pending'`, [invoiceId]).catch(() => {});
    } else {
      // рахунок без підписки = оплата платного модуля (add-on) → вмикаємо фічу
      await applyAddonInvoicePaid(invoiceId).catch(e => console.error('[billing] addon-paid', e.message));
    }
  }
  return pay;
}

// ── Оплата рахунку підписки через Mono (pay-link) ────────────────────
// Створює інвойс Mono на суму рахунку й повертає посилання на оплату.
// Ідемпотентно: живий pending-лінк повертається повторно.
async function createSubscriptionPayLink(invoiceId) {
  if (!process.env.MONO_TOKEN) throw new Error('gateway-not-configured');
  const pool = getPool();
  const inv = (await pool.query(`SELECT * FROM invoices_saas WHERE id=$1`, [invoiceId])).rows[0];
  if (!inv) throw new Error('invoice-not-found');
  if (inv.status === 'paid') return { alreadyPaid: true };
  if (inv.status === 'void') throw new Error('invoice-void');
  if (Number(inv.total) <= 0) throw new Error('invoice-zero-amount');

  const existing = (await pool.query(
    `SELECT gateway_payment_id, gateway_response FROM payments_saas
       WHERE invoice_id=$1 AND gateway='monobank' AND status IN ('pending','processing')
         AND created_at > NOW()-INTERVAL '24 hours' ORDER BY id DESC LIMIT 1`, [invoiceId])).rows[0];
  if (existing && existing.gateway_response && existing.gateway_response.page_url) {
    return { pay_url: existing.gateway_response.page_url, mono_invoice_id: existing.gateway_payment_id, reused: true };
  }

  const mono = require('./mono');
  // Рахунок ПІДПИСКИ — дохід ПЛАТФОРМИ: інвойс завжди на платформенний токен Mono,
  // навіть якщо виклик прийшов у контексті салона-орендаря (runAs(null) → env-токен).
  // Клієнтські оплати салонів навпаки йдуть per-tenant (аудит v6).
  const { runAs } = require('./tenant');
  const monoInv = await runAs(null, () => mono.createInvoice({
    amountUah: Number(inv.total),
    orderId: `saas-${invoiceId}`,
    destination: `Підписка SVS CRM — рахунок ${inv.invoice_number}`.slice(0, 280),
  }));
  await pool.query(
    `INSERT INTO payments_saas (tenant_id, invoice_id, amount, currency, status, gateway, gateway_payment_id, gateway_response)
     VALUES ($1,$2,$3,$4,'pending','monobank',$5,$6)`,
    [inv.tenant_id, invoiceId, Number(inv.total), inv.currency || 'UAH', monoInv.invoiceId,
     JSON.stringify({ page_url: monoInv.pageUrl })]);
  return { pay_url: monoInv.pageUrl, mono_invoice_id: monoInv.invoiceId };
}

// Надсилає власнику салону нагадування про оплату продовження підписки з pay-link.
// Використовується dunning-циклом (manual/Mono): без реальної відправки клієнт не знав,
// що треба платити — раніше processDunning лише виставляв notification_sent=TRUE без дії.
async function notifyOwnerPayLink(tenantId, invoiceId) {
  const pool = getPool();
  const bs = (await pool.query(
    `SELECT bot_token, owner_chat_id FROM tenant_bot_settings WHERE tenant_id=$1 AND status='connected'`,
    [tenantId])).rows[0];
  let payUrl = null;
  try { const link = await createSubscriptionPayLink(invoiceId); if (link && !link.alreadyPaid) payUrl = link.pay_url; }
  catch (e) { /* pay-link опційний (немає MONO_TOKEN) — надсилаємо текст без посилання */ }
  const text = payUrl
    ? `💳 <b>Продовження підписки SVS CRM</b>\nПотрібна оплата, щоб не втратити доступ.\nОплатити: ${payUrl}`
    : `💳 <b>Продовження підписки SVS CRM</b>\nПотрібна оплата. Відкрийте розділ «Підписка» в адмінці.`;
  // 1) Telegram — основной канал
  if (bs && bs.bot_token && bs.owner_chat_id) {
    try {
      const { tgCall } = require('./tenant-bots');
      await tgCall(bs.bot_token, 'sendMessage', { chat_id: bs.owner_chat_id, text, parse_mode: 'HTML' });
      return { sent: true, channel: 'telegram', payUrl: !!payUrl };
    } catch (e) { /* падаем на email ниже */ }
  }
  // 2) Email fallback (аудит v6: салон без подключённого Telegram-бота не получал
  //    НИ ОДНОГО платёжного напоминания и улетал в suspend без предупреждения)
  try {
    const emailCh = require('./channels/email-resend');
    if (emailCh.isConfigured()) {
      const owner = (await pool.query(
        `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id=$1 AND r.code='owner' AND u.email IS NOT NULL AND u.is_active
          ORDER BY u.id LIMIT 1`, [tenantId])).rows[0];
      if (owner && owner.email) {
        await emailCh.send(owner.email, { subject: 'Оплата підписки SVS CRM', body: text.replace(/\n/g, '<br>') });
        return { sent: true, channel: 'email', payUrl: !!payUrl };
      }
    }
  } catch (e) { return { sent: false, reason: e.message?.slice(0, 80) }; }
  return { sent: false, reason: 'no-owner-contact' };
}

// Викликається вебхуком/полінгом Mono (payments-mono.js), коли рахунок підписки
// має фінальний статус. На success — позначає рахунок оплаченим і активує підписку.
async function payInvoiceViaMono(monoInvoiceId, data) {
  const pool = getPool();
  const pay = (await pool.query(
    `SELECT * FROM payments_saas WHERE gateway='monobank' AND gateway_payment_id=$1 ORDER BY id DESC LIMIT 1`,
    [monoInvoiceId])).rows[0];
  if (!pay) return { ok: false, reason: 'unknown-saas-invoice' };
  if (pay.status === 'succeeded') return { ok: true, status: 'paid', dedup: true };

  if (data.status === 'success') {
    await pool.query(`UPDATE payments_saas SET status='succeeded', gateway_response=$2, updated_at=NOW() WHERE id=$1`,
      [pay.id, JSON.stringify(data)]);
    const inv = (await pool.query(
      `UPDATE invoices_saas SET status='paid', paid_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status<>'paid' RETURNING *`, [pay.invoice_id])).rows[0];
    if (inv && inv.subscription_id) {
      const sub = (await pool.query(
        `UPDATE subscriptions_saas SET status='active', updated_at=NOW() WHERE id=$1 RETURNING *`, [inv.subscription_id])).rows[0];
      if (sub) {
        await syncLicense(sub.tenant_id, sub.plan_code, 'active', sub.current_period_end).catch(() => {});
        await pool.query(`UPDATE tenants SET status='active', updated_at=NOW() WHERE id=$1`, [sub.tenant_id]).catch(() => {});
        _invalidateTenantCache(sub.tenant_id);
        try { require('./feature-gate').invalidateFeatureCache(sub.tenant_id); } catch (_) {}
        // Партнёрка: Mono-оплата тоже должна награждать реферера (как recordPayment).
        try { await require('./partner-referrals').onReferredPaid(sub.tenant_id); } catch (e) { console.error('[mono:partner]', e.message); }
      }
      await pool.query(`UPDATE dunning_attempts SET status='succeeded' WHERE invoice_id=$1 AND status='pending'`, [pay.invoice_id]).catch(() => {});
    } else if (inv) {
      // рахунок без підписки = оплата платного модуля (add-on) → вмикаємо фічу
      await applyAddonInvoicePaid(inv.id).catch(e => console.error('[billing] addon-paid', e.message));
    }
    return { ok: true, status: 'paid' };
  }

  if (['failure', 'expired', 'reversed'].includes(data.status)) {
    await pool.query(`UPDATE payments_saas SET status='failed', failure_reason=$2, gateway_response=$3, updated_at=NOW() WHERE id=$1`,
      [pay.id, data.status, JSON.stringify(data)]);
    return { ok: true, status: 'failed' };
  }
  return { ok: true, status: data.status };
}

// ── Add-on модулі: self-service оплата (SAS-11) ──────────────────────
// Салон сам купує платний модуль: рахунок (subscription_id=NULL) → Mono pay-link
// → оплата → applyAddonInvoicePaid вмикає override[feature]=true. Несплата = вимкнено.
const ADDON_PERIOD_DAYS = { monthly: 30, yearly: 365 };

// Створити рахунок на платний модуль + запис-замовлення (status='pending').
// Повертає {invoice, addon}. Кидає addon-not-found / addon-not-paid.
async function createAddonInvoice(tenantId, featureKey, cycle = 'monthly') {
  if (!tenantId) throw new Error('tenant-required');
  const pool = getPool();
  const addon = (await pool.query(
    `SELECT feature_key, name, price_month, price_year FROM saas_addons WHERE feature_key=$1 AND active=true`,
    [featureKey])).rows[0];
  if (!addon) throw new Error('addon-not-found');
  const billingCycle = cycle === 'yearly' ? 'yearly' : 'monthly';
  const price = Number(billingCycle === 'yearly' ? addon.price_year : addon.price_month) || 0;
  if (price <= 0) throw new Error('addon-not-paid');
  const days = ADDON_PERIOD_DAYS[billingCycle];

  const num = await nextInvoiceNumber();
  const inv = (await pool.query(
    `INSERT INTO invoices_saas (tenant_id, subscription_id, invoice_number, status, subtotal,
       discount_amount, tax_amount, total, period_start, period_end, line_items, notes)
     VALUES ($1,NULL,$2,'open',$3,0,0,$3, NOW(), NOW()+($4||' days')::interval, $5, $6) RETURNING *`,
    [tenantId, num, price, days,
     JSON.stringify([{ description: `Модуль «${addon.name}» (${billingCycle === 'yearly' ? 'рік' : 'місяць'})`, amount: price, qty: 1 }]),
     `addon:${featureKey}`])).rows[0];

  // upsert замовлення; якщо вже active — не збиваємо статус (це продовження)
  await pool.query(
    `INSERT INTO tenant_addon_subscriptions (tenant_id, feature_key, status, billing_cycle, price, last_invoice_id, updated_at)
     VALUES ($1,$2,'pending',$3,$4,$5,now())
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET
       billing_cycle=EXCLUDED.billing_cycle, price=EXCLUDED.price,
       last_invoice_id=EXCLUDED.last_invoice_id, updated_at=now()`,
    [tenantId, featureKey, billingCycle, price, inv.id]);
  return { invoice: inv, addon };
}

// Викликається після оплати рахунку модуля (вебхук Mono / ручна оплата):
// вмикає override[feature]=true, продовжує період add-on-підписки.
async function applyAddonInvoicePaid(invoiceId) {
  const pool = getPool();
  const order = (await pool.query(
    `SELECT * FROM tenant_addon_subscriptions WHERE last_invoice_id=$1 LIMIT 1`, [invoiceId])).rows[0];
  if (!order) return { ok: false, reason: 'not-addon-invoice' };
  const days = ADDON_PERIOD_DAYS[order.billing_cycle] || 30;
  // продовження від поточного кінця періоду (якщо ще не минув), інакше від тепер
  await pool.query(
    `UPDATE tenant_addon_subscriptions
        SET status='active',
            current_period_end = GREATEST(COALESCE(current_period_end, now()), now()) + ($2||' days')::interval,
            updated_at=now()
      WHERE id=$1`, [order.id, days]);
  // увімкнути фічу в overrides; гарантуємо наявність ліцензії (solo за замовч.)
  await pool.query(
    `INSERT INTO tenant_licenses (tenant_id, plan_code, status, overrides, updated_at)
     VALUES ($1,'solo','active', jsonb_build_object($2::text,true), now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       overrides = COALESCE(tenant_licenses.overrides,'{}'::jsonb) || jsonb_build_object($2::text,true),
       updated_at=now()`,
    [order.tenant_id, order.feature_key]);
  _invalidateTenantCache(order.tenant_id);
  return { ok: true, feature: order.feature_key, tenant_id: order.tenant_id };
}

// Прострочені add-on підписки: період скінчився, оплати продовження не було →
// вимкнути модуль (override=false), статус past_due. Без витоку: несплата = вимкнено.
// Викликається з runRecurring (той самий cron, що й продовження підписок).
async function runAddonExpiry(limit = 200) {
  const pool = getPool();
  const due = (await pool.query(
    `SELECT * FROM tenant_addon_subscriptions
      WHERE status='active' AND current_period_end IS NOT NULL AND current_period_end <= now()
      ORDER BY current_period_end LIMIT $1`, [limit])).rows;
  let expired = 0;
  for (const o of due) {
    await pool.query(`UPDATE tenant_addon_subscriptions SET status='past_due', updated_at=now() WHERE id=$1`, [o.id]);
    await pool.query(
      `UPDATE tenant_licenses
          SET overrides = COALESCE(overrides,'{}'::jsonb) || jsonb_build_object($2::text,false), updated_at=now()
        WHERE tenant_id=$1`, [o.tenant_id, o.feature_key]);
    _invalidateTenantCache(o.tenant_id);
    expired++;
  }
  return { due: due.length, expired };
}

// Скасувати модуль вручну (салон сам вимикає): override=false + cancelled.
async function cancelAddon(tenantId, featureKey) {
  const pool = getPool();
  await pool.query(
    `UPDATE tenant_addon_subscriptions SET status='cancelled', updated_at=now()
      WHERE tenant_id=$1 AND feature_key=$2`, [tenantId, featureKey]);
  await pool.query(
    `UPDATE tenant_licenses
        SET overrides = COALESCE(overrides,'{}'::jsonb) || jsonb_build_object($2::text,false), updated_at=now()
      WHERE tenant_id=$1`, [tenantId, featureKey]);
  _invalidateTenantCache(tenantId);
  return { ok: true };
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
      // manual/Mono: авто-charge немає — реально надсилаємо власнику pay-link у Telegram
      // (раніше notification_sent=TRUE виставлявся без жодної відправки — клієнт не платив).
      const notif = await notifyOwnerPayLink(d.tenant_id, d.invoice_id).catch(() => ({ sent: false }));
      await pool.query(`UPDATE dunning_attempts SET status='attempted', attempted_at=NOW(), notification_sent=$3, notification_type='telegram', gateway_response=$2 WHERE id=$1`,
        [d.id, result.raw ? JSON.stringify(result.raw) : null, !!notif.sent]);
      // последняя попытка провалена → suspend
      if (d.attempt_number >= DUNNING_OFFSETS_H.length) {
        await pool.query(`UPDATE subscriptions_saas SET status='suspended', updated_at=NOW() WHERE id=$1`, [d.subscription_id]);
        await pool.query(`UPDATE tenants SET status='suspended', updated_at=NOW() WHERE id=$1`, [d.tenant_id]).catch(() => {});
        _invalidateTenantCache(d.tenant_id);
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
      // авто-charge если шлюз настроен, иначе dunning (manual/Mono = pay-link, ожидание оплаты)
      const g = gateway(renewedSub.payment_gateway);
      if (renewedSub.payment_gateway !== 'manual' && g.configured()) {
        try {
          const r = await g.charge({ tenantId: sub.tenant_id, amount: Number(inv.total) });
          if (r.status === 'succeeded') await recordPayment(inv.id, { gateway: renewedSub.payment_gateway, status: 'succeeded', gatewayPaymentId: r.gateway_payment_id, raw: r.raw });
          else await scheduleDunning(renewedSub.id, inv.id);
        } catch { await scheduleDunning(renewedSub.id, inv.id); }
      } else {
        // manual/Mono: авто-списання картки немає (Mono = разове pay-link). Раніше рахунок
        // при продовженні створювався у вакуумі — клієнт не отримував нагадування й не платив,
        // а suspend не наставав (dunning не планувався). Тепер запускаємо dunning-цикл:
        // processDunning надішле власнику salon pay-link, після N невдач → suspend.
        await scheduleDunning(renewedSub.id, inv.id).catch(e => console.error('[billing] renew dunning', e.message));
      }
    }
  }
  // прострочені платні модулі (несплата продовження) → вимкнути, без витоку
  const addons = await runAddonExpiry().catch(e => { console.error('[billing] addon-expiry', e.message); return { expired: 0 }; });
  return { due: due.length, renewed, cancelled, invoiced, addons_expired: addons.expired };
}

// ── Метрики (для SAS-07) ─────────────────────────────────────────────
async function billingMetrics() {
  const pool = getPool();
  // MRR: місячний еквівалент підписок, що РЕАЛЬНО платять (active/past_due + є успішна оплата),
  // тільки справжні клієнти (is_internal=false). Тріал у MRR не входить (#56/#57).
  // MRR из saas_plans_v2 (единая истина цен) с маппингом legacy-кодов — иначе салоны на
  // тарифах starter/professional выпадали из INNER JOIN saas_plans и MRR был занижен.
  const subs = (await pool.query(
    `SELECT s.plan_code, s.billing_cycle, p.price_monthly_uah AS price_month, p.price_yearly_uah AS price_year
       FROM subscriptions_saas s
       JOIN tenants t ON t.id=s.tenant_id AND t.is_internal=FALSE
       JOIN saas_plans_v2 p ON p.slug = CASE s.plan_code WHEN 'pro' THEN 'professional' WHEN 'solo' THEN 'free' ELSE s.plan_code END
      WHERE s.status IN ('active','past_due')
        AND EXISTS (SELECT 1 FROM payments_saas pay WHERE pay.tenant_id=s.tenant_id AND pay.status='succeeded')`)).rows;
  let mrr = 0;
  for (const s of subs) mrr += s.billing_cycle === 'yearly' ? Number(s.price_year) / 12 : Number(s.price_month);
  mrr = Math.round(mrr * 100) / 100;
  const byStatus = (await pool.query(
    `SELECT s.status, count(*)::int n FROM subscriptions_saas s
       JOIN tenants t ON t.id=s.tenant_id AND t.is_internal=FALSE GROUP BY s.status`)).rows;
  const st = {}; byStatus.forEach(r => st[r.status] = r.n);
  const active = (st.active || 0) + (st.trialing || 0);
  const cancelled30 = Number((await pool.query(
    `SELECT count(*)::int n FROM subscriptions_saas s JOIN tenants t ON t.id=s.tenant_id AND t.is_internal=FALSE
      WHERE s.status='cancelled' AND s.cancelled_at>=NOW()-INTERVAL '30 days'`)).rows[0].n);
  const churn = active + cancelled30 > 0 ? Math.round((cancelled30 / (active + cancelled30)) * 1000) / 10 : 0;
  const revenue30 = Number((await pool.query(
    `SELECT COALESCE(SUM(pay.amount),0) s FROM payments_saas pay JOIN tenants t ON t.id=pay.tenant_id AND t.is_internal=FALSE
      WHERE pay.status='succeeded' AND pay.created_at>=NOW()-INTERVAL '30 days'`)).rows[0].s);
  const outstanding = Number((await pool.query(
    `SELECT COALESCE(SUM(i.total),0) s FROM invoices_saas i JOIN tenants t ON t.id=i.tenant_id AND t.is_internal=FALSE
      WHERE i.status='open'`)).rows[0].s);
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
  getSubscription, createSubscription, changePlan, cancelSubscription, resumeSubscription, syncLicense,
  // invoices
  generateInvoice, listInvoices, getInvoice, voidInvoice, dueAlert,
  // payments
  recordPayment, listPayments, refundPayment,
  createSubscriptionPayLink, payInvoiceViaMono,
  // add-on modules (SAS-11)
  createAddonInvoice, applyAddonInvoicePaid, runAddonExpiry, cancelAddon,
  // methods
  listPaymentMethods, addPaymentMethod, removePaymentMethod, setDefaultPaymentMethod,
  // promo crud
  listPromoCodes, createPromoCode, updatePromoCode, deletePromoCode,
  // dunning / recurring / metrics
  scheduleDunning, processDunning, runRecurring, billingMetrics,
};
