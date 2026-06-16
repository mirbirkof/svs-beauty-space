/* routes/billing.js — SAS-03 Billing. /api/billing
   Tenant (guard saas.read/saas.write — салон управляет своей подпиской, current_tenant_id):
     GET   /subscription            текущая подписка
     POST  /subscription            оформить { plan_code, cycle, promo_code? }
     PATCH /subscription            смена тарифа (prorated) { plan_code, cycle? }
     POST  /subscription/cancel     { reason?, immediate? }
     POST  /subscription/resume
     GET   /invoices                свои счета ?status&limit&offset
     GET   /invoices/:id            счёт + платежи
     GET   /payments                свои платежи
     GET   /payment-methods         методы оплаты
     POST  /payment-methods         добавить { gateway, token, ... }
     DELETE /payment-methods/:id
     PUT   /payment-methods/:id/default
     POST  /promo/validate          { code } → { valid, discount }
     GET   /gateways                статус доступных шлюзов
   Superadmin (guard saas.read/saas.write):
     GET   /admin/subscriptions               ?status&limit
     GET   /admin/subscriptions/:tenantId
     POST  /admin/subscriptions/:tenantId/override  { plan_code, cycle, trial? }
     GET   /admin/invoices                    ?status&from&to
     POST  /admin/invoices/:id/void
     POST  /admin/invoices/:id/pay            ручная отметка оплаты (офлайн-перевод)
     POST  /admin/payments/:id/refund         { amount? }
     GET   /admin/dunning
     POST  /admin/dunning/run                 прогнать готовые попытки (cron)
     POST  /admin/recurring/run               recurring billing tick (cron)
     GET   /admin/metrics                     MRR/ARR/churn
     GET   /admin/promo-codes                 ?active
     POST  /admin/promo-codes
     PATCH /admin/promo-codes/:id
     DELETE /admin/promo-codes/:id
   Webhooks (public, проверка подписи внутри шлюза):
     POST  /webhooks/:gateway */
const express = require('express');
const router = express.Router();
const { requirePerm, logAction } = require('../lib/rbac');
const { getTenantId } = require('../lib/tenant');
const billing = require('../lib/billing');

const TENANT_R = requirePerm('saas.read');
const TENANT_W = requirePerm('saas.write');
const ADMIN_R = requirePerm('saas.read');
const ADMIN_W = requirePerm('saas.write');

const fail = (res, e) => {
  console.error('[billing]', e);
  const m = e.message || '';
  const code = /not-found/.test(m) ? 404 : /required|promo-|expired|not-refundable|not-configured/.test(m) ? 400 : 500;
  res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : m });
};

// ── TENANT ───────────────────────────────────────────────────────────
router.get('/subscription', TENANT_R, async (req, res) => {
  try { res.json(await billing.getSubscription(getTenantId())); } catch (e) { fail(res, e); }
});

router.post('/subscription', TENANT_W, async (req, res) => {
  try {
    const sub = await billing.createSubscription(getTenantId(), req.body || {}, req.user);
    await logAction({ user: req.user, action: 'billing.subscribe', entity: 'subscriptions_saas', ip: req.ip });
    res.status(201).json({ ok: true, subscription: sub });
  } catch (e) { fail(res, e); }
});

router.patch('/subscription', TENANT_W, async (req, res) => {
  try {
    const { plan_code, cycle } = req.body || {};
    if (!plan_code) return res.status(400).json({ error: 'plan_code-required' });
    const r = await billing.changePlan(getTenantId(), plan_code, cycle || null);
    await logAction({ user: req.user, action: 'billing.change_plan', entity: 'subscriptions_saas', ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

router.post('/subscription/cancel', TENANT_W, async (req, res) => {
  try {
    const sub = await billing.cancelSubscription(getTenantId(), { reason: req.body?.reason, immediate: !!req.body?.immediate });
    await logAction({ user: req.user, action: 'billing.cancel', entity: 'subscriptions_saas', ip: req.ip });
    res.json({ ok: true, subscription: sub });
  } catch (e) { fail(res, e); }
});

router.post('/subscription/resume', TENANT_W, async (req, res) => {
  try { res.json({ ok: true, subscription: await billing.resumeSubscription(getTenantId()) }); } catch (e) { fail(res, e); }
});

router.get('/invoices', TENANT_R, async (req, res) => {
  try {
    res.json(await billing.listInvoices({
      tenantId: getTenantId(), status: req.query.status || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/invoices/:id', TENANT_R, async (req, res) => {
  try {
    const inv = await billing.getInvoice(Number(req.params.id), getTenantId());
    if (!inv) return res.status(404).json({ error: 'invoice-not-found' });
    res.json(inv);
  } catch (e) { fail(res, e); }
});

// Створити/отримати посилання на онлайн-оплату рахунку підписки через Mono
router.post('/invoices/:id/pay-link', TENANT_W, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inv = await billing.getInvoice(id, getTenantId()); // перевірка належності тенанту
    if (!inv) return res.status(404).json({ error: 'invoice-not-found' });
    const link = await billing.createSubscriptionPayLink(id);
    await logAction({ user: req.user, action: 'billing.pay_link', entity: 'invoices_saas', entityId: id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, ...link });
  } catch (e) { fail(res, e); }
});

router.get('/payments', TENANT_R, async (req, res) => {
  try {
    res.json(await billing.listPayments({
      tenantId: getTenantId(), limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/payment-methods', TENANT_R, async (req, res) => {
  try { res.json({ rows: await billing.listPaymentMethods(getTenantId()) }); } catch (e) { fail(res, e); }
});

router.post('/payment-methods', TENANT_W, async (req, res) => {
  try { res.status(201).json({ ok: true, method: await billing.addPaymentMethod(getTenantId(), req.body || {}) }); } catch (e) { fail(res, e); }
});

router.delete('/payment-methods/:id', TENANT_W, async (req, res) => {
  try { await billing.removePaymentMethod(getTenantId(), Number(req.params.id)); res.status(204).end(); } catch (e) { fail(res, e); }
});

router.put('/payment-methods/:id/default', TENANT_W, async (req, res) => {
  try { res.json({ ok: true, method: await billing.setDefaultPaymentMethod(getTenantId(), Number(req.params.id)) }); } catch (e) { fail(res, e); }
});

router.post('/promo/validate', TENANT_R, async (req, res) => {
  try {
    const { code, plan_code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code-required' });
    res.json(await billing.validatePromo(code, plan_code || null));
  } catch (e) { fail(res, e); }
});

router.get('/gateways', TENANT_R, async (req, res) => {
  try { res.json(billing.gatewayStatus()); } catch (e) { fail(res, e); }
});

// ── SUPERADMIN ───────────────────────────────────────────────────────
router.get('/admin/subscriptions', ADMIN_R, async (req, res) => {
  try {
    const { getPool } = require('../db-pg');
    const where = [], params = []; let i = 1;
    if (req.query.status) { where.push(`s.status=$${i++}`); params.push(req.query.status); }
    if (req.query.plan_code) { where.push(`s.plan_code=$${i++}`); params.push(req.query.plan_code); }
    const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(Math.min(Number(req.query.limit) || 50, 200), Number(req.query.offset) || 0);
    const rows = (await getPool().query(
      `SELECT s.*, t.name AS tenant_name FROM subscriptions_saas s
         LEFT JOIN tenants t ON t.id=s.tenant_id ${ws}
        ORDER BY s.created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows;
    res.json({ rows });
  } catch (e) { fail(res, e); }
});

router.get('/admin/subscriptions/:tenantId', ADMIN_R, async (req, res) => {
  try {
    const sub = await billing.getSubscription(req.params.tenantId);
    if (!sub) return res.status(404).json({ error: 'subscription-not-found' });
    const inv = await billing.listInvoices({ tenantId: req.params.tenantId, limit: 20 });
    res.json({ subscription: sub, invoices: inv.rows });
  } catch (e) { fail(res, e); }
});

router.post('/admin/subscriptions/:tenantId/override', ADMIN_W, async (req, res) => {
  try {
    const sub = await billing.createSubscription(req.params.tenantId, { ...req.body, trial: req.body?.trial === true }, req.user);
    await logAction({ user: req.user, action: 'billing.override', entity: 'subscriptions_saas', entity_id: req.params.tenantId, ip: req.ip });
    res.json({ ok: true, subscription: sub });
  } catch (e) { fail(res, e); }
});

router.get('/admin/invoices', ADMIN_R, async (req, res) => {
  try {
    res.json(await billing.listInvoices({
      status: req.query.status || null, from: req.query.from || null, to: req.query.to || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.post('/admin/invoices/:id/void', ADMIN_W, async (req, res) => {
  try {
    const inv = await billing.voidInvoice(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'invoice-not-found-or-paid' });
    await logAction({ user: req.user, action: 'billing.void', entity: 'invoices_saas', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, invoice: inv });
  } catch (e) { fail(res, e); }
});

// Ручная отметка оплаты (офлайн банковский перевод).
router.post('/admin/invoices/:id/pay', ADMIN_W, async (req, res) => {
  try {
    const pay = await billing.recordPayment(Number(req.params.id), {
      amount: req.body?.amount ?? null, gateway: 'manual', status: 'succeeded', raw: { manual: true, by: req.user?.name || null },
    });
    await logAction({ user: req.user, action: 'billing.manual_pay', entity: 'invoices_saas', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, payment: pay });
  } catch (e) { fail(res, e); }
});

router.post('/admin/payments/:id/refund', ADMIN_W, async (req, res) => {
  try {
    const p = await billing.refundPayment(Number(req.params.id), req.body?.amount ?? null);
    await logAction({ user: req.user, action: 'billing.refund', entity: 'payments_saas', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, payment: p });
  } catch (e) { fail(res, e); }
});

router.get('/admin/dunning', ADMIN_R, async (req, res) => {
  try {
    const { getPool } = require('../db-pg');
    const rows = (await getPool().query(
      `SELECT d.*, s.tenant_id, s.plan_code, i.invoice_number, i.total
         FROM dunning_attempts d JOIN subscriptions_saas s ON s.id=d.subscription_id
         JOIN invoices_saas i ON i.id=d.invoice_id
        WHERE d.status IN ('pending','attempted') ORDER BY d.scheduled_at LIMIT 200`)).rows;
    res.json({ rows });
  } catch (e) { fail(res, e); }
});

router.post('/admin/dunning/run', ADMIN_W, async (req, res) => {
  try { res.json(await billing.processDunning(Number(req.body?.limit) || 100)); } catch (e) { fail(res, e); }
});

router.post('/admin/recurring/run', ADMIN_W, async (req, res) => {
  try { res.json(await billing.runRecurring(Number(req.body?.limit) || 200)); } catch (e) { fail(res, e); }
});

router.get('/admin/metrics', ADMIN_R, async (req, res) => {
  try { res.json(await billing.billingMetrics()); } catch (e) { fail(res, e); }
});

router.get('/admin/promo-codes', ADMIN_R, async (req, res) => {
  try {
    res.json(await billing.listPromoCodes({
      active: req.query.active != null ? req.query.active === 'true' : null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.post('/admin/promo-codes', ADMIN_W, async (req, res) => {
  try {
    const p = await billing.createPromoCode(req.body || {}, req.user);
    await logAction({ user: req.user, action: 'billing.promo_create', entity: 'promo_codes_saas', entity_id: p.id, ip: req.ip });
    res.status(201).json({ ok: true, promo: p });
  } catch (e) { fail(res, e); }
});

router.patch('/admin/promo-codes/:id', ADMIN_W, async (req, res) => {
  try {
    const p = await billing.updatePromoCode(Number(req.params.id), req.body || {});
    if (!p) return res.status(404).json({ error: 'promo-not-found' });
    res.json({ ok: true, promo: p });
  } catch (e) { fail(res, e); }
});

router.delete('/admin/promo-codes/:id', ADMIN_W, async (req, res) => {
  try {
    const p = await billing.deletePromoCode(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'promo-not-found' });
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

// ── WEBHOOKS (public; проверка подписи внутри шлюза при наличии ключей) ──
router.post('/webhooks/:gateway', async (req, res) => {
  try {
    const gw = req.params.gateway;
    const st = billing.gatewayStatus();
    if (!(gw in st)) return res.status(404).json({ error: 'unknown-gateway' });
    if (!st[gw]) return res.status(503).json({ error: 'gateway-not-configured' });
    // фактическая обработка событий шлюза подключается вместе с ключами; пока ack.
    console.log('[billing] webhook', gw, JSON.stringify(req.body || {}).slice(0, 200));
    res.json({ received: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
