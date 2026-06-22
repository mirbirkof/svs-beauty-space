/* routes/domains.js — SAS-09 Tenant Domains. /api/domains
   Tenant (guard saas.read/saas.write, current_tenant_id):
     GET    /                       свои домены
     POST   /                       добавить { domain, method? } → 201 (+ verification_token + dns_records)
     GET    /:id                    домен + SSL + DNS-записи
     DELETE /:id
     POST   /:id/verify             реальная DNS-проверка (TXT/CNAME)
     POST   /:id/set-primary
     PATCH  /:id/settings           { redirect_www?, force_https?, custom_headers? }
     GET    /:id/dns-instructions   ?provider=cloudflare
     GET    /:id/health             HTTP + SSL-срок
   Superadmin (guard saas.read/saas.write):
     GET    /admin/all              ?status&tenant_id
     GET    /admin/dashboard
     POST   /admin/:id/force-verify
     POST   /admin/:id/renew-ssl
     GET    /admin/ssl/expiring     ?days=30
     POST   /admin/ssl/renew-all
     POST   /admin/ssl/refresh      пометить просроченные (cron)
     GET    /admin/health-report */
const express = require('express');
const router = express.Router();
const { requirePerm, requirePlatform, logAction } = require('../lib/rbac');
const { getTenantId } = require('../lib/tenant');
const dom = require('../lib/domains');

const R = requirePerm('saas.read');
const W = requirePerm('saas.write');

// Усі /admin/* — кросс-тенантні операції оператора платформи (список доменів
// УСІХ салонів, force-verify/renew SSL будь-якого домену, health-report).
// Без цього власник салону (роль owner з правами "*") пройшов би saas.read/write
// і бачив/керував доменами чужих салонів. Салонні маршрути (нижче) лишаються
// під current_tenant_id + RLS.
router.use('/admin', requirePlatform());

const fail = (res, e) => {
  console.error('[domains]', e);
  const m = e.message || '';
  const code = /not-found/.test(m) ? 404 : /invalid|already-exists|not-active|required/.test(m) ? 400 : 500;
  res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : m });
};

// ── SUPERADMIN (объявляем ДО /:id, чтобы /admin не ловился как id) ────
router.get('/admin/all', R, async (req, res) => {
  try {
    res.json(await dom.listDomains({
      tenantId: req.query.tenant_id || null, status: req.query.status || null,
      limit: Math.min(Number(req.query.limit) || 100, 500), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/admin/dashboard', R, async (req, res) => {
  try { res.json(await dom.dashboard()); } catch (e) { fail(res, e); }
});

router.post('/admin/:id/force-verify', W, async (req, res) => {
  try {
    const r = await dom.verifyDomain(Number(req.params.id));
    await logAction({ user: req.user, action: 'domain.force_verify', entity: 'custom_domains', entity_id: req.params.id, ip: req.ip });
    res.json(r);
  } catch (e) { fail(res, e); }
});

router.post('/admin/:id/renew-ssl', W, async (req, res) => {
  try {
    const r = await dom.renewSsl(Number(req.params.id));
    await logAction({ user: req.user, action: 'domain.renew_ssl', entity: 'ssl_certificates', entity_id: req.params.id, ip: req.ip });
    res.json(r);
  } catch (e) { fail(res, e); }
});

router.get('/admin/ssl/expiring', R, async (req, res) => {
  try { res.json(await dom.expiringSsl(Number(req.query.days) || 30)); } catch (e) { fail(res, e); }
});

router.post('/admin/ssl/renew-all', W, async (req, res) => {
  try { res.json(await dom.renewAll(Number(req.body?.days) || 30)); } catch (e) { fail(res, e); }
});

router.post('/admin/ssl/refresh', W, async (req, res) => {
  try { res.json(await dom.refreshSslStatuses()); } catch (e) { fail(res, e); }
});

router.get('/admin/health-report', R, async (req, res) => {
  try { res.json(await dom.healthReport()); } catch (e) { fail(res, e); }
});

// ── TENANT ───────────────────────────────────────────────────────────
router.get('/', R, async (req, res) => {
  try { res.json(await dom.listDomains({ tenantId: getTenantId(), status: req.query.status || null })); } catch (e) { fail(res, e); }
});

router.post('/', W, async (req, res) => {
  try {
    const { domain, method } = req.body || {};
    if (!domain) return res.status(400).json({ error: 'domain-required' });
    const d = await dom.addDomain(getTenantId(), domain, { method });
    await logAction({ user: req.user, action: 'domain.add', entity: 'custom_domains', ip: req.ip });
    res.status(201).json(d);
  } catch (e) { fail(res, e); }
});

router.get('/:id', R, async (req, res) => {
  try {
    const d = await dom.getDomain(Number(req.params.id), getTenantId());
    if (!d) return res.status(404).json({ error: 'domain-not-found' });
    res.json(d);
  } catch (e) { fail(res, e); }
});

router.delete('/:id', W, async (req, res) => {
  try { await dom.removeDomain(getTenantId(), Number(req.params.id)); res.status(204).end(); } catch (e) { fail(res, e); }
});

router.post('/:id/verify', W, async (req, res) => {
  try { res.json(await dom.verifyDomain(Number(req.params.id), getTenantId())); } catch (e) { fail(res, e); }
});

router.post('/:id/set-primary', W, async (req, res) => {
  try { res.json({ ok: true, domain: await dom.setPrimary(getTenantId(), Number(req.params.id)) }); } catch (e) { fail(res, e); }
});

router.patch('/:id/settings', W, async (req, res) => {
  try { res.json(await dom.updateSettings(getTenantId(), Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});

router.get('/:id/dns-instructions', R, async (req, res) => {
  try {
    const d = await dom.getDomain(Number(req.params.id), getTenantId());
    if (!d) return res.status(404).json({ error: 'domain-not-found' });
    res.json(dom.dnsInstructions(d.domain, req.query.provider || 'generic'));
  } catch (e) { fail(res, e); }
});

router.get('/:id/health', R, async (req, res) => {
  try { res.json(await dom.domainHealth(Number(req.params.id), getTenantId())); } catch (e) { fail(res, e); }
});

module.exports = router;
