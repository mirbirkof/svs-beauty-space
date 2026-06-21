/* routes/security.js — INF-05 Security Center API. Монтується як /api/security.
   Читання: audit.read (owner/admin/manager). Управління: security.manage (owner/admin).
   Покриває: security events (list/active/resolve/stats), IP whitelist (CRUD),
   політику паролів (get/put), зведений dashboard, ручний запуск детектора загроз. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const sc = require('../lib/security-center');

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
function fail(res, e, ctx) {
  console.error(`[security] ${ctx}:`, e.message);
  const code = /required|invalid|not.?found/i.test(e.message) ? 400 : 500;
  res.status(code).json({ error: e.message });
}

/* ── Dashboard ─────────────────────────────────────────────── */
router.get('/dashboard', requirePerm('audit.read'), async (req, res) => {
  try { res.json(await sc.dashboard()); } catch (e) { fail(res, e, 'dashboard'); }
});

/* ── Security events ───────────────────────────────────────── */
router.get('/events', requirePerm('audit.read'), async (req, res) => {
  try { res.json(await sc.listEvents(req.query)); } catch (e) { fail(res, e, 'events'); }
});

router.get('/events/active', requirePerm('audit.read'), async (req, res) => {
  try { res.json(await sc.listEvents({ ...req.query, resolved: 'false' })); } catch (e) { fail(res, e, 'events.active'); }
});

router.get('/events/stats', requirePerm('audit.read'), async (req, res) => {
  try { res.json(await sc.eventStats()); } catch (e) { fail(res, e, 'events.stats'); }
});

router.post('/events/:id/resolve', requirePerm('security.manage'), async (req, res) => {
  try {
    const ok = await sc.resolveEvent(parseInt(req.params.id, 10), req.user?.id);
    if (!ok) return res.status(404).json({ error: 'not-found' });
    res.json({ resolved: true });
  } catch (e) { fail(res, e, 'events.resolve'); }
});

router.post('/events/detect', requirePerm('security.manage'), async (req, res) => {
  try { res.json(await sc.detectThreats()); } catch (e) { fail(res, e, 'events.detect'); }
});

/* ── IP whitelist ──────────────────────────────────────────── */
router.get('/ip-whitelist', requirePerm('audit.read'), async (req, res) => {
  try { res.json({ rows: await sc.listWhitelist() }); } catch (e) { fail(res, e, 'whitelist.list'); }
});

router.post('/ip-whitelist', requirePerm('security.manage'), async (req, res) => {
  try {
    const row = await sc.addWhitelist({ ...req.body, created_by: req.user?.id });
    res.status(201).json({ data: row });
  } catch (e) { fail(res, e, 'whitelist.add'); }
});

router.delete('/ip-whitelist/:id', requirePerm('security.manage'), async (req, res) => {
  try {
    const ok = await sc.removeWhitelist(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'not-found' });
    res.json({ deleted: true });
  } catch (e) { fail(res, e, 'whitelist.remove'); }
});

/* ── Password policy ───────────────────────────────────────── */
router.get('/password-policy', requirePerm('audit.read'), async (req, res) => {
  try { res.json({ data: await sc.getPolicy() }); } catch (e) { fail(res, e, 'policy.get'); }
});

router.put('/password-policy', requirePerm('security.manage'), async (req, res) => {
  try { res.json({ data: await sc.updatePolicy(req.body || {}) }); } catch (e) { fail(res, e, 'policy.put'); }
});

module.exports = router;
