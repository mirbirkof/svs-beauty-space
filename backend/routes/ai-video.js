/* routes/ai-video.js — VID-01 AI Video Studio (серверная генерация промо-видео).
   Аналог PalmierPro без Mac: раскадровка (бесплатно) → кадры (Nano Banana) →
   видео-клипы (Veo). Монтируется как /api/ai/video.
   Права: чтение/раскадровка — marketing.read; генерация кадров/видео — marketing.write
   (генерация = трата платной квоты Google, поэтому write).
   Платные эндпоинты при отсутствии биллинга возвращают 402 paid_key_required —
   это штатный ответ, а не сбой. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const studio = require('../lib/ai-video-studio');

const canRead = requirePerm('marketing.read');
const canWrite = requirePerm('marketing.write');

function fail(res, e, ctx) {
  console.error(`[ai-video] ${ctx}:`, e.message);
  const code = /required|invalid|parse/i.test(e.message) ? 400 : 500;
  res.status(code).json({ error: e.message });
}

/** Возможности студии — что доступно сейчас (нужен ли платный ключ). */
router.get('/readiness', canRead, (req, res) => {
  try { res.json(studio.readiness()); } catch (e) { fail(res, e, 'readiness'); }
});

/** Раскадровка из брифа — бесплатно (текстовый LLM). */
router.post('/storyboard', canRead, async (req, res) => {
  try {
    const { brief, scenes, aspect, lang, brandVoice } = req.body || {};
    res.json(await studio.storyboard(brief, { scenes, aspect, lang, brandVoice }));
  } catch (e) { fail(res, e, 'storyboard'); }
});

/** Ключевой кадр (платно: Nano Banana). 402 если нет платного ключа. */
router.post('/frame', canWrite, async (req, res) => {
  try {
    const { prompt, aspect } = req.body || {};
    const out = await studio.generateFrame(prompt, { aspect });
    if (out.error === 'paid_key_required') return res.status(402).json(out);
    res.json(out);
  } catch (e) { fail(res, e, 'frame'); }
});

/** Запустить генерацию видео-клипа (платно: Veo). Возвращает operation для поллинга. */
router.post('/clip', canWrite, async (req, res) => {
  try {
    const { prompt, aspect, durationSec, image } = req.body || {};
    const out = await studio.startClip(prompt, { aspect, durationSec, image });
    if (out.error === 'paid_key_required') return res.status(402).json(out);
    res.json(out);
  } catch (e) { fail(res, e, 'clip.start'); }
});

/** Проверить готовность клипа. ?operation=models/.../operations/... */
router.get('/clip', canRead, async (req, res) => {
  try {
    const op = req.query.operation;
    const out = await studio.pollClip(op);
    if (out.error === 'paid_key_required') return res.status(402).json(out);
    res.json(out);
  } catch (e) { fail(res, e, 'clip.poll'); }
});

module.exports = router;
