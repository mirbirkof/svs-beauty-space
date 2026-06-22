/* routes/ai-video.js — VID-01 AI Video Studio (серверная генерация промо-видео).
   Аналог PalmierPro без Mac: раскадровка (бесплатно) → кадры (Nano Banana) →
   видео-клипы (Veo). Монтируется как /api/ai/video.
   Права: чтение/раскадровка — marketing.read; генерация кадров/видео — marketing.write
   (генерация = трата платной квоты Google, поэтому write).
   Платные эндпоинты при отсутствии биллинга возвращают 402 paid_key_required —
   это штатный ответ, а не сбой. */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const studio = require('../lib/ai-video-studio');
const montager = require('../lib/ai-video-montage');

const canRead = requirePerm('marketing.read');
const canWrite = requirePerm('marketing.write');

// Загрузка своих клипов: в память (montage сам пишет во временную папку и чистит).
// Лимиты — защита и от DoS, и от таймаутов рендера на проде.
const uploadClips = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: montager.MAX_CLIPS },
}).array('clips', montager.MAX_CLIPS);

function fail(res, e, ctx) {
  console.error(`[ai-video] ${ctx}:`, e.message);
  const code = /required|invalid|parse/i.test(e.message) ? 400 : 500;
  res.status(code).json({ error: e.message });
}

/** Возможности студии — что доступно сейчас (нужен ли платный ключ). */
router.get('/readiness', canRead, (req, res) => {
  try { res.json(studio.readiness()); } catch (e) { fail(res, e, 'readiness'); }
});

/** Диагностика ffmpeg на хосте: есть ли бинарь, исполняем ли, версия.
 *  Нужно чтобы понять почему montage падает на Render (502/OOM vs нет бинаря). */
router.get('/montage-diag', canRead, (req, res) => {
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  let ffmpegPath = null, ffmpegErr = null;
  try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegErr = e.message; }
  const out = {
    ffmpegPath,
    ffmpegRequireErr: ffmpegErr,
    exists: ffmpegPath ? fs.existsSync(ffmpegPath) : false,
    fontExists: fs.existsSync(montager.FONT || ''),
    node: process.version,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    limits: { MAX_CLIPS: montager.MAX_CLIPS, MAX_SEC_CLIP: montager.MAX_SECONDS_PER_CLIP, MAX_TOTAL: montager.MAX_TOTAL_SECONDS },
  };
  if (out.exists) {
    try {
      const st = fs.statSync(ffmpegPath);
      out.mode = (st.mode & 0o777).toString(8);
      out.sizeMB = +(st.size / 1048576).toFixed(1);
      const r = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 10000 });
      out.version = r.stdout ? r.stdout.split('\n')[0] : null;
      out.spawnErr = r.error ? r.error.message : (r.stderr ? r.stderr.slice(0, 200) : null);
      out.spawnStatus = r.status;
    } catch (e) { out.statErr = e.message; }
  }
  res.json(out);
});

/** Раскадровка из брифа — бесплатно (текстовый LLM). */
router.post('/storyboard', canRead, async (req, res) => {
  try {
    const { brief, scenes, aspect, lang, brandVoice } = req.body || {};
    res.json(await studio.storyboard(brief, { scenes, aspect, lang, brandVoice }));
  } catch (e) { fail(res, e, 'storyboard'); }
});

/** Оркестратор: бриф → сценарий+подпись+хештеги (бесплатно) + опц. рендер видео.
 *  render=true стартует Veo → нужен marketing.write (тратит платную квоту). */
router.post('/produce', async (req, res) => {
  const wantsRender = !!(req.body && req.body.render);
  const guard = wantsRender ? canWrite : canRead;
  guard(req, res, async () => {
    try {
      const { brief, scenes, aspect, lang, brandVoice, render } = req.body || {};
      res.json(await studio.produce(brief, { scenes, aspect, lang, brandVoice, render }));
    } catch (e) { fail(res, e, 'produce'); }
  });
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

/** Монтаж из СВОИХ видео: загрузить 1..N клипов + (опц.) титры сцен → один промо-MP4.
 *  Бесплатно (локальный ffmpeg, без платной квоты Google) → marketing.read.
 *  multipart/form-data: clips[] = файлы; scenes = JSON [{caption,durationSec}]; aspect. */
router.post('/montage', canRead, (req, res) => {
  uploadClips(req, res, async (upErr) => {
    if (upErr) {
      const code = upErr.code === 'LIMIT_FILE_SIZE' ? 413
        : upErr.code === 'LIMIT_FILE_COUNT' ? 400 : 400;
      return res.status(code).json({ error: upErr.code === 'LIMIT_FILE_SIZE'
        ? `файл завеликий (макс 80 МБ на кліп)` : upErr.message });
    }
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no clips uploaded' });
    let scenes = [];
    try { scenes = req.body.scenes ? JSON.parse(req.body.scenes) : []; }
    catch { scenes = []; }
    if (!Array.isArray(scenes)) scenes = [];
    const aspect = (req.body.aspect || '9:16').toString();

    let result = null;
    try {
      result = await montager.montage(
        files.map((f) => ({ buffer: f.buffer, name: f.originalname })),
        scenes,
        { aspect }
      );
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="svs-promo.mp4"');
      res.setHeader('X-Montage-Duration', String(result.durationSec));
      res.setHeader('X-Montage-Clips', String(result.clips));
      const stream = require('fs').createReadStream(result.path);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.on('close', () => result.cleanup());
      stream.pipe(res);
    } catch (e) {
      if (result) result.cleanup();
      // ошибки контента/лимитов — это вина ввода, не сервера → 400
      if (/відео|clips|max |монтувати|nothing/i.test(e.message)) {
        console.error('[ai-video] montage:', e.message);
        return res.status(400).json({ error: e.message });
      }
      fail(res, e, 'montage');
    }
  });
});

module.exports = router;
