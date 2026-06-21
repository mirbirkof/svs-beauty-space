/* routes/google-ads.js — MKT-09 Google Ads API.
   Префікс монтування: /api/google-ads.
   Авторизація: marketing.read на GET, marketing.write на мутації (owner = '*').
   RLS гарантує ізоляцію по tenant. Живі виклики Google Ads API — graceful:
   без developer-token/refresh усе локальне, мережеві операції no-op. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const gads = require('../lib/google-ads');

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'marketing.read' : 'marketing.write';
  return requirePerm(perm)(req, res, next);
});

const fail = (res, e) => {
  const known = /required|not-found|invalid/.test(e.message || '');
  res.status(known ? 400 : 500).json({
    error: process.env.NODE_ENV === 'production' && !known ? 'Internal server error' : e.message,
  });
};

// ── Акаунти ─────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try { res.json({ items: await gads.listAccounts() }); } catch (e) { fail(res, e); }
});
router.post('/accounts/connect', async (req, res) => {
  try { res.json(await gads.connectAccount(req.body || {})); } catch (e) { fail(res, e); }
});
router.delete('/accounts/:id', async (req, res) => {
  try { res.json(await gads.disconnectAccount(Number(req.params.id))); } catch (e) { fail(res, e); }
});
router.post('/accounts/:id/sync', async (req, res) => {
  try { res.json(await gads.syncAccount(Number(req.params.id))); } catch (e) { fail(res, e); }
});

// ── Кампанії ────────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const { account_id, status, from, to } = req.query;
    res.json({ items: await gads.listCampaigns({ accountId: account_id ? Number(account_id) : undefined, status, from, to }) });
  } catch (e) { fail(res, e); }
});
router.get('/campaigns/:id/stats', async (req, res) => {
  try { res.json({ items: await gads.campaignStats(Number(req.params.id), { from: req.query.from, to: req.query.to }) }); } catch (e) { fail(res, e); }
});
router.post('/campaigns/:id/toggle', async (req, res) => {
  try {
    const status = (req.body?.status || '').toUpperCase();
    if (!['ENABLED', 'PAUSED'].includes(status)) return res.status(400).json({ error: 'status-invalid' });
    res.json(await gads.toggleCampaign(Number(req.params.id), status));
  } catch (e) { fail(res, e); }
});

// ── Ключові слова / пошукові запити ─────────────────────────────────
router.get('/keywords', async (req, res) => {
  try { res.json(await gads.listKeywords({ accountId: req.query.account_id ? Number(req.query.account_id) : undefined, campaignId: req.query.campaign_id })); } catch (e) { fail(res, e); }
});
router.get('/search-terms', async (req, res) => {
  try { res.json(await gads.searchTerms({ accountId: req.query.account_id ? Number(req.query.account_id) : undefined, campaignId: req.query.campaign_id })); } catch (e) { fail(res, e); }
});

// ── Конверсії ───────────────────────────────────────────────────────
router.get('/conversions', async (req, res) => {
  try {
    const u = req.query.uploaded;
    const uploaded = u === 'true' ? true : (u === 'false' ? false : undefined);
    res.json({ items: await gads.listConversions({ uploaded, limit: req.query.limit }) });
  } catch (e) { fail(res, e); }
});
router.post('/conversions', async (req, res) => {
  try { res.json(await gads.recordConversion(req.body || {})); } catch (e) { fail(res, e); }
});
router.post('/conversions/upload', async (req, res) => {
  try { res.json(await gads.uploadConversions()); } catch (e) { fail(res, e); }
});

// ── ROI ─────────────────────────────────────────────────────────────
router.get('/roi', async (req, res) => {
  try { res.json(await gads.roi({ from: req.query.from, to: req.query.to })); } catch (e) { fail(res, e); }
});

module.exports = router;
