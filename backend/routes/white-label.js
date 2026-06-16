/* routes/white-label.js — SAS-02 White Label / SAS-08 Branding. /api/white-label
   Tenant (guard saas.read/saas.write):
     GET  /config            текущий конфиг + preview/published CSS
     PUT  /config            обновить настройки/черновик темы (→ preview)
     POST /apply-preset      применить пресет (→ preview)
     POST /publish           опубликовать preview (версия + история)
     POST /rollback          откат к версии из истории
     GET  /history           история версий
     GET  /presets           библиотека пресетов
     POST /presets           upsert пресета (saas.write)
   Public (без авторизации, для виджета/PWA; тенант из X-Tenant-Slug или :slug):
     GET  /public/theme.css      опубликованный CSS текущего тенанта
     GET  /public/theme/:slug.css CSS конкретного тенанта по slug
     GET  /public/brand          карточка бренда текущего тенанта
     GET  /public/brand/:slug    карточка бренда по slug */
const express = require('express');
const router = express.Router();
const { requirePerm, logAction } = require('../lib/rbac');
const { resolveBySlug, runAs } = require('../lib/tenant');
const wl = require('../lib/white-label');

const fail = (res, e) => { console.error(e); res.status(e.message && /not-found/.test(e.message) ? 404 : 500).json({ error: process.env.NODE_ENV === 'production' && !/not-found|required/.test(e.message || '') ? 'Internal server error' : e.message }); };

// ── ПУБЛИЧНЫЕ (объявляем ДО guard'ов) ────────────────────────────────
async function serveCss(res, c) {
  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(wl.publishedCSS(c));
}

router.get('/public/theme.css', async (req, res) => {
  try { await serveCss(res, await wl.getConfig()); } catch (e) { fail(res, e); }
});

router.get('/public/theme/:slug.css', async (req, res) => {
  try {
    const t = await resolveBySlug(req.params.slug);
    if (!t) return res.status(404).json({ error: 'tenant-not-found' });
    await runAs(t.id, async () => serveCss(res, await wl.getConfig()));
  } catch (e) { fail(res, e); }
});

router.get('/public/brand', async (req, res) => {
  try { res.json(await wl.brand()); } catch (e) { fail(res, e); }
});

router.get('/public/brand/:slug', async (req, res) => {
  try {
    const t = await resolveBySlug(req.params.slug);
    if (!t) return res.status(404).json({ error: 'tenant-not-found' });
    await runAs(t.id, async () => res.json(await wl.brand()));
  } catch (e) { fail(res, e); }
});

// ── TENANT (guard) ───────────────────────────────────────────────────
router.get('/config', requirePerm('saas.read'), async (req, res) => {
  try {
    const c = await wl.getConfig();
    res.json({ config: c, preview_css: wl.previewCSS(c), published_css: wl.publishedCSS(c), can_hide_powered_by: await wl.canHidePoweredBy() });
  } catch (e) { fail(res, e); }
});

router.put('/config', requirePerm('saas.write'), async (req, res) => {
  try {
    const c = await wl.updateConfig(req.body || {});
    await logAction({ user: req.user, action: 'wl.config_update', entity: 'white_label_configs', ip: req.ip });
    res.json({ ok: true, config: c, preview_css: wl.previewCSS(c) });
  } catch (e) { fail(res, e); }
});

router.post('/apply-preset', requirePerm('saas.write'), async (req, res) => {
  try {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug-required' });
    const c = await wl.applyPreset(slug);
    res.json({ ok: true, config: c, preview_css: wl.previewCSS(c) });
  } catch (e) { fail(res, e); }
});

router.post('/publish', requirePerm('saas.write'), async (req, res) => {
  try {
    const c = await wl.publish({ changeReason: req.body?.change_reason, userId: req.user?.id || null });
    await logAction({ user: req.user, action: 'wl.publish', entity: 'white_label_configs', ip: req.ip });
    res.json({ ok: true, version: c.version, config: c, published_css: wl.publishedCSS(c) });
  } catch (e) { fail(res, e); }
});

router.post('/rollback', requirePerm('saas.write'), async (req, res) => {
  try {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: 'version-required' });
    const c = await wl.rollback(Number(version));
    await logAction({ user: req.user, action: 'wl.rollback', entity: 'white_label_configs', ip: req.ip });
    res.json({ ok: true, config: c, published_css: wl.publishedCSS(c) });
  } catch (e) { fail(res, e); }
});

router.get('/history', requirePerm('saas.read'), async (req, res) => {
  try { res.json({ rows: await wl.history(Number(req.query.limit) || 20) }); } catch (e) { fail(res, e); }
});

router.get('/presets', requirePerm('saas.read'), async (req, res) => {
  try { res.json({ rows: await wl.listPresets(req.query.category || null) }); } catch (e) { fail(res, e); }
});

router.post('/presets', requirePerm('saas.write'), async (req, res) => {
  try { res.json({ ok: true, preset: await wl.upsertPreset(req.body || {}) }); } catch (e) { fail(res, e); }
});

module.exports = router;
