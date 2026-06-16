/* routes/tenant-mgmt.js — SAS-06 Tenant Management. /api/tenant-mgmt
   Суперадмин (guard saas.read/saas.write) — кросс-тенантные операции платформы:
     GET  /dashboard                      сводка по всем тенантам + health + открытые тикеты
     GET  /tenants                        список (status/search/limit/offset)
     GET  /tenants/:id                    детали тенанта (лицензия, онбординг, health)
     POST /tenants/:id/block              приостановить (status=suspended)
     POST /tenants/:id/unblock            вернуть (status=active)
     GET  /tenants/:id/onboarding         прогресс онбординга
     PATCH /tenants/:id/onboarding        csm/notes
     POST /tenants/:id/onboarding/complete  отметить шаг
     GET  /tenants/:id/health             посчитать health сейчас
     POST /tenants/:id/health/check       записать health-чек в историю
     POST /health/check-all               прогнать health по всем активным
     GET  /tickets                        список тикетов (tenant/status/priority/assigned)
     GET  /tickets/:id                     тикет + переписка (incl. internal)
     PATCH /tickets/:id                   статус/приоритет/назначение/internal_notes
     POST /tickets/:id/reply              ответ персонала (is_staff)
     GET  /support/stats                  метрики поддержки
   Tenant-facing (guard users.read/write — салон видит только своё):
     GET  /my/onboarding                  свой онбординг
     POST /my/onboarding/complete         отметить свой шаг
     GET  /my/tickets                     свои тикеты
     POST /my/tickets                     создать тикет
     GET  /my/tickets/:id                 свой тикет (без internal)
     POST /my/tickets/:id/reply           ответ клиента */
const express = require('express');
const router = express.Router();
const { requirePerm, logAction } = require('../lib/rbac');
const { getTenantId } = require('../lib/tenant');
const tm = require('../lib/tenant-mgmt');

const fail = (res, e) => {
  console.error('[tenant-mgmt]', e);
  const msg = e.message || '';
  const code = /not-found/.test(msg) ? 404 : /required|invalid/.test(msg) ? 400 : 500;
  res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : msg });
};

// ── СУПЕРАДМИН: дашборд / тенанты ────────────────────────────────────
router.get('/dashboard', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.dashboard()); } catch (e) { fail(res, e); }
});

router.get('/tenants', requirePerm('saas.read'), async (req, res) => {
  try {
    res.json(await tm.listTenants({
      status: req.query.status || null, search: req.query.search || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/tenants/:id', requirePerm('saas.read'), async (req, res) => {
  try {
    const d = await tm.tenantDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'tenant-not-found' });
    res.json(d);
  } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/block', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.setStatus(req.params.id, 'suspended', req.body?.reason || null);
    await logAction({ user: req.user, action: 'tenant.block', entity: 'tenants', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, tenant: r });
  } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/unblock', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.setStatus(req.params.id, 'active', req.body?.reason || null);
    await logAction({ user: req.user, action: 'tenant.unblock', entity: 'tenants', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, tenant: r });
  } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: онбординг тенанта ────────────────────────────────────
router.get('/tenants/:id/onboarding', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.getOnboarding(req.params.id)); } catch (e) { fail(res, e); }
});

router.patch('/tenants/:id/onboarding', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.updateOnboarding(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/onboarding/complete', requirePerm('saas.write'), async (req, res) => {
  try {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step-required' });
    res.json(await tm.completeStep(req.params.id, step));
  } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: health ───────────────────────────────────────────────
router.get('/tenants/:id/health', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.computeHealth(req.params.id)); } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/health/check', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.runHealthCheck(req.params.id)); } catch (e) { fail(res, e); }
});

router.post('/health/check-all', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.runHealthAll()); } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: тикеты поддержки ─────────────────────────────────────
router.get('/tickets', requirePerm('saas.read'), async (req, res) => {
  try {
    res.json(await tm.listTickets({
      tenantId: req.query.tenant_id || null, status: req.query.status || null,
      priority: req.query.priority || null, assigned: req.query.assigned || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/tickets/:id', requirePerm('saas.read'), async (req, res) => {
  try {
    const t = await tm.getTicket(Number(req.params.id), { includeInternal: true });
    if (!t) return res.status(404).json({ error: 'ticket-not-found' });
    res.json(t);
  } catch (e) { fail(res, e); }
});

router.patch('/tickets/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const t = await tm.updateTicket(Number(req.params.id), req.body || {});
    if (!t) return res.status(404).json({ error: 'ticket-not-found' });
    await logAction({ user: req.user, action: 'ticket.update', entity: 'tenant_support_tickets', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, ticket: t });
  } catch (e) { fail(res, e); }
});

router.post('/tickets/:id/reply', requirePerm('saas.write'), async (req, res) => {
  try {
    const reply = await tm.replyTicket(Number(req.params.id), {
      message: req.body?.message, internal: !!req.body?.internal, isStaff: true, user: req.user,
    });
    res.json({ ok: true, reply });
  } catch (e) { fail(res, e); }
});

router.get('/support/stats', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.supportStats()); } catch (e) { fail(res, e); }
});

// ── TENANT-FACING: свой онбординг / тикеты (current_tenant_id) ────────
router.get('/my/onboarding', requirePerm('users.read'), async (req, res) => {
  try { res.json(await tm.getOnboarding(getTenantId())); } catch (e) { fail(res, e); }
});

router.post('/my/onboarding/complete', requirePerm('users.write'), async (req, res) => {
  try {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step-required' });
    res.json(await tm.completeStep(getTenantId(), step));
  } catch (e) { fail(res, e); }
});

router.get('/my/tickets', requirePerm('users.read'), async (req, res) => {
  try {
    res.json(await tm.listTickets({
      tenantId: getTenantId(), status: req.query.status || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.post('/my/tickets', requirePerm('users.write'), async (req, res) => {
  try {
    const t = await tm.createTicket(getTenantId(), req.body || {}, req.user);
    res.status(201).json({ ok: true, ticket: t });
  } catch (e) { fail(res, e); }
});

router.get('/my/tickets/:id', requirePerm('users.read'), async (req, res) => {
  try {
    const t = await tm.getTicket(Number(req.params.id), { includeInternal: false });
    if (!t || String(t.ticket.tenant_id) !== String(getTenantId())) return res.status(404).json({ error: 'ticket-not-found' });
    res.json(t);
  } catch (e) { fail(res, e); }
});

router.post('/my/tickets/:id/reply', requirePerm('users.write'), async (req, res) => {
  try {
    const cur = await tm.getTicket(Number(req.params.id), { includeInternal: false });
    if (!cur || String(cur.ticket.tenant_id) !== String(getTenantId())) return res.status(404).json({ error: 'ticket-not-found' });
    const reply = await tm.replyTicket(Number(req.params.id), {
      message: req.body?.message, internal: false, isStaff: false, user: req.user,
    });
    res.json({ ok: true, reply });
  } catch (e) { fail(res, e); }
});

module.exports = router;
