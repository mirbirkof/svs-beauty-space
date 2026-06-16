/* routes/rfm.js — RFM-аналіз (MKT-04). /api/rfm
   GET  /            зведення: сегменти + 5×5 матриця (heat-map)
   GET  /labels      довідник макросегментів (назва+підказка)
   GET  /:segment    клієнти сегмента (для розсилки/експорту)
   POST /refresh     перерахувати rfm_scores */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const rfm = require('../lib/rfm');

const SEGMENTS = Object.keys(rfm.SEGMENT_LABELS);
const err = (res, e) => { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };

router.get('/labels', requirePerm('reports.read'), (req, res) => {
  res.json({ labels: rfm.SEGMENT_LABELS });
});

router.get('/', requirePerm('reports.read'), async (req, res) => {
  try { res.json(await rfm.summary()); } catch (e) { err(res, e); }
});

router.post('/refresh', requirePerm('reports.read'), async (req, res) => {
  try { const n = await rfm.refresh(); res.json({ ok: true, processed: n, ...(await rfm.summary()) }); }
  catch (e) { err(res, e); }
});

router.get('/:segment', requirePerm('reports.read'), async (req, res) => {
  try {
    if (!SEGMENTS.includes(req.params.segment)) return res.status(404).json({ error: 'unknown segment' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const items = await rfm.members(req.params.segment, { limit });
    res.json({ segment: req.params.segment, count: items.length, items });
  } catch (e) { err(res, e); }
});

module.exports = router;
