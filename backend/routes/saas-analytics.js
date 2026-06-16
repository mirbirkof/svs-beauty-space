/* routes/saas-analytics.js — SaaS-аналітика (SAS-07). /api/saas/analytics
   GET /            повний огляд (MRR/ARR/ARPU + воронка + churn + когорти + LTV)
   GET /metrics     лише метрики доходу
   GET /funnel      воронка signup→trial→paid
   GET /churn?months=12
   GET /cohorts     когортна утримуваність
   GET /ltv         LTV / avg lifetime
   Guard: saas.read (superadmin SaaS control plane). */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const sa = require('../lib/saas-analytics');

router.use(requirePerm('saas.read'));
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
};

router.get('/', wrap(() => sa.overview()));
router.get('/metrics', wrap(() => sa.metrics()));
router.get('/funnel', wrap(() => sa.funnel()));
router.get('/churn', wrap(req => sa.churn({ months: req.query.months })));
router.get('/cohorts', wrap(() => sa.cohorts()));
router.get('/ltv', wrap(() => sa.ltv()));

module.exports = router;
