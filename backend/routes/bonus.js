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

// ── 04.11 Бонуси майстру за клієнта (lib/visit-loyalty) ─────────────
// ставки за умовами (повернення / перезапис / висока оцінка) і поріг оцінки
router.get('/master-loyalty', async (req, res) => {
  try { res.json(await require('../lib/visit-loyalty').getConfig()); } catch (e) { fail(res, e); }
});
router.put('/master-loyalty', async (req, res) => {
  try {
    res.json(await require('../lib/visit-loyalty').saveConfig(req.body || {}, req.user && req.user.id));
  } catch (e) { /^invalid-/.test(e.message) ? res.status(400).json({ error: e.message }) : fail(res, e); }
});
// історія нарахувань конкретному майстру (картка майстра в CRM)
router.get('/master-rewards', async (req, res) => {
  const mid = Number(req.query.master_id);
  if (!Number.isSafeInteger(mid) || mid <= 0) return res.status(400).json({ error: 'master_id required' });
  try { res.json(await require('../lib/visit-loyalty').masterRewards(mid, Math.min(500, Number(req.query.limit) || 100))); }
  catch (e) { fail(res, e); }
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

// Звірка нарахованого кешбеку зі станом візитів: знімає бонуси за скасованими/зниклими
// візитами. ?dry=1 — лише показати, скільки й на яку суму (нічого не змінює).
router.post('/reconcile', async (req, res) => {
  try {
    const dryRun = String(req.query.dry || req.body?.dry || '') === '1';
    const rec = require('../lib/bonus-reconcile');
    const accruals = await rec.reconcileBonusAccruals({ dryRun });
    // Аудит 13.08: разом зі звіркою нарахувань лікуємо і лічильники «нараховано/списано
    // за весь час» — вони інкрементуються окремо і дрейфують від журналу (клієнт #365).
    const counters = await rec.reconcileBonusCounters({ dryRun });
    res.json({ ...accruals, counters });
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

// #174: розбивка по кліку на плитку (нараховано / списано / згоріло / баланси)
router.get('/stats', async (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    if (!/^(accrued|redeemed|expired|liability|clients)$/.test(kind)) return res.status(400).json({ error: 'kind-required' });
    res.json(await bonus.stats(kind, Number(req.query.days) || 0));
  } catch (e) { fail(res, e); }
});

module.exports = router;
