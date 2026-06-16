/* routes/attribution.js — мультиканальна атрибуція + UTM (MKT-10). /api/attribution
   POST /track        ПУБЛІЧНИЙ — фіксація точки дотику з лендінгу/віджета (utm/gclid/fbclid)
   POST /link         прив'язати анонімні дотики до клієнта (auth)
   GET  /             порівняння моделей атрибуції по каналах за період (auth)
   GET  /utm          UTM-звіт по source/medium/campaign (auth) */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const attr = require('../lib/attribution');

const err = (res, e) => { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };

// ПУБЛІЧНИЙ — без авторизації (як booking-catalog). Лише запис, без читання.
router.post('/track', async (req, res) => {
  try {
    const b = req.body || {};
    const tp = await attr.track({
      client_id: b.client_id, anon_id: b.anon_id,
      channel: b.channel, utm_source: b.utm_source, utm_medium: b.utm_medium,
      utm_campaign: b.utm_campaign, utm_term: b.utm_term, utm_content: b.utm_content,
      gclid: b.gclid, fbclid: b.fbclid, referrer: b.referrer || req.get('referer'),
      landing_path: b.landing_path,
    });
    res.json({ ok: true, id: tp.id, channel: tp.channel });
  } catch (e) { err(res, e); }
});

router.post('/link', requirePerm('reports.read'), async (req, res) => {
  try {
    const { anon_id, client_id } = req.body || {};
    const n = await attr.linkAnon(anon_id, Number(client_id));
    res.json({ ok: true, linked: n });
  } catch (e) { err(res, e); }
});

router.get('/', requirePerm('reports.read'), async (req, res) => {
  try { res.json(await attr.compute({ from: req.query.from, to: req.query.to })); }
  catch (e) { err(res, e); }
});

router.get('/utm', requirePerm('reports.read'), async (req, res) => {
  try { res.json(await attr.utmReport({ from: req.query.from, to: req.query.to })); }
  catch (e) { err(res, e); }
});

module.exports = router;
