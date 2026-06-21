/* routes/instagram-content.js — COM-10: Instagram публікації + insights.
   Монтується як /api/instagram-content. Права: omnichannel.read (GET) /
   omnichannel.write (мутації) — узгоджено з рештою omnichannel-області.
   Токени беруться з підключеного каналу (omni_channels), тут не зберігаються. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const ic = require('../lib/instagram-content');

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'omnichannel.read' : 'omnichannel.write';
  return requirePerm(perm)(req, res, next);
});

function fail(res, e, ctx) {
  console.error(`[ig-content] ${ctx}:`, e.message);
  const code = /required|invalid|not.?found/i.test(e.message) ? 400 : 500;
  res.status(code).json({ error: e.message });
}

/* Зведення (insights + кількість запланованих) */
router.get('/summary', async (req, res) => {
  try { res.json(await ic.summary()); } catch (e) { fail(res, e, 'summary'); }
});

router.get('/insights', async (req, res) => {
  try { res.json(await ic.accountInsights({ days: parseInt(req.query.days, 10) || 28 })); } catch (e) { fail(res, e, 'insights'); }
});

router.get('/media', async (req, res) => {
  try { res.json(await ic.listMedia({ limit: parseInt(req.query.limit, 10) || 12 })); } catch (e) { fail(res, e, 'media'); }
});

router.get('/media/:id/insights', async (req, res) => {
  try { res.json(await ic.mediaInsights(req.params.id)); } catch (e) { fail(res, e, 'media.insights'); }
});

/* Заплановані пости */
router.get('/scheduled', async (req, res) => {
  try { res.json({ rows: await ic.listScheduled({ status: req.query.status, limit: req.query.limit }) }); } catch (e) { fail(res, e, 'scheduled.list'); }
});

router.post('/publish', async (req, res) => {
  try {
    const row = await ic.schedulePost({ ...req.body, created_by: req.user?.id });
    res.status(201).json({ data: row });
  } catch (e) { fail(res, e, 'publish'); }
});

router.delete('/scheduled/:id', async (req, res) => {
  try {
    const ok = await ic.cancelScheduled(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'not-found' });
    res.json({ canceled: true });
  } catch (e) { fail(res, e, 'scheduled.cancel'); }
});

module.exports = router;
