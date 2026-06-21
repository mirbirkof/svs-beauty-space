/* routes/bonus.js — FIN-01 Bonus System API.
   Префікс монтування: /api/bonus. Авторизація: loyalty.read на GET, loyalty.write на мутації
   (бонуси — частина домену лояльності; owner має '*'). RLS забезпечує ізоляцію по tenant. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const bonus = require('../lib/bonus');

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'loyalty.read' : 'loyalty.write';
  return requirePerm(perm)(req, res, next);
});

const fail = (res, e) => res.status(/required|insufficient|below-min|disabled|zero-after|mismatch/.test(e.message) ? 400 : 500)
  .json({ error: process.env.NODE_ENV === 'production' && !/required|insufficient|below-min|disabled|zero-after|mismatch/.test(e.message) ? 'Internal server error' : e.message });

// ── Налаштування ────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try { res.json(await bonus.getSettings()); } catch (e) { fail(res, e); }
});
router.put('/settings', async (req, res) => {
  try { res.json(await bonus.saveSettings(req.body || {})); } catch (e) { fail(res, e); }
});

// ── Правила нарахування (CRUD) ──────────────────────────────────────
router.get('/rules', async (req, res) => {
  try { res.json({ items: await bonus.listRules() }); } catch (e) { fail(res, e); }
});
router.post('/rules', async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'name-required' });
    res.json(await bonus.createRule(req.body));
  } catch (e) { fail(res, e); }
});
router.put('/rules/:id', async (req, res) => {
  try { res.json(await bonus.updateRule(Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});
router.delete('/rules/:id', async (req, res) => {
  try { res.json(await bonus.deleteRule(Number(req.params.id))); } catch (e) { fail(res, e); }
});

// ── Баланс і історія клієнта ────────────────────────────────────────
router.get('/balance/:clientId', async (req, res) => {
  try {
    const cid = Number(req.params.clientId);
    const [balance, history] = await Promise.all([bonus.getBalance(cid), bonus.getHistory(cid)]);
    res.json({ balance, history });
  } catch (e) { fail(res, e); }
});

// ── Операції ────────────────────────────────────────────────────────
router.post('/accrue', async (req, res) => {
  try {
    const tx = await bonus.accrue(req.body || {});
    res.json(tx || { skipped: true });
  } catch (e) { fail(res, e); }
});
router.post('/redeem', async (req, res) => {
  try { res.json(await bonus.redeem(req.body || {})); } catch (e) { fail(res, e); }
});
router.post('/adjust', async (req, res) => {
  try {
    const adjustedBy = req.user?.id || null;
    res.json(await bonus.manualAdjust({ ...(req.body || {}), adjustedBy }));
  } catch (e) { fail(res, e); }
});

// ── Сгорання вручну (зазвичай через cron) ───────────────────────────
router.post('/expire', async (req, res) => {
  try { res.json(await bonus.expireBonuses()); } catch (e) { fail(res, e); }
});

// ── Аналітика ───────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try { res.json(await bonus.analytics()); } catch (e) { fail(res, e); }
});

module.exports = router;
