/* routes/ai-video.js — VID-01 AI Video Studio (серверная генерация промо-видео).
   Аналог PalmierPro без Mac: раскадровка (бесплатно) → кадры (Nano Banana) →
   видео-клипы (Veo). Монтируется как /api/ai/video.
   Права: чтение/раскадровка — marketing.read; генерация кадров/видео — marketing.write
   (генерация = трата платной квоты Google, поэтому write).
   Платные эндпоинты при отсутствии биллинга возвращают 402 paid_key_required —
   это штатный ответ, а не сбой. */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const studio = require('../lib/ai-video-studio');
const montager = require('../lib/ai-video-montage');
const fileStore = require('../lib/file-store'); // общее облако (мульти-сервер)
let _pool = null;
function db() { if (!_pool) { try { _pool = require('../db-pg').getPool(); } catch { _pool = null; } } return _pool; }

const canRead = requirePerm('marketing.read');
const canWrite = requirePerm('marketing.write');

// Куди зберігаємо готові ролики (той самий диск, що й files.js).
// UPLOADS_DIR — постоянный диск (Render Disk); без него локальная папка (эфемерна на Render).
const UPLOAD_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const VIDEO_DIR = path.join(UPLOAD_ROOT, 'video');

// Загрузка своих клипов: НА ДИСК (17.07.2026 — было memoryStorage: 8×80МБ буферов
// в RAM убивали Render 512MB задолго до ffmpeg; это и была часть «montage падает»).
// + поле music (опц. фоновая музыка для режима Reels).
const os = require('os');
const reel = require('../lib/ai-video-reel');
const upDiskDir = path.join(os.tmpdir(), 'ai-video-up');
try { fs.mkdirSync(upDiskDir, { recursive: true }); } catch {}
const uploadClips = multer({
  storage: multer.diskStorage({
    destination: upDiskDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 80 * 1024 * 1024, files: montager.MAX_CLIPS + 1 },
}).fields([
  { name: 'clips', maxCount: montager.MAX_CLIPS },
  { name: 'music', maxCount: 1 },
]);
const rmUploads = (req) => {
  const all = [...((req.files && req.files.clips) || []), ...((req.files && req.files.music) || [])];
  for (const f of all) fsp.rm(f.path, { force: true }).catch(() => {});
};

// ─── Асинхронные задания рендера (Reels) ───────────────────────────────────
// Синхронный HTTP-ответ на проде обрывается прокси при рендере >100с → job+поллинг.
const jobs = new Map(); // id → { status, stage, error, videoId, tenantId, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}, 15 * 60 * 1000).unref();

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

/** Сохранить готовый ролик в библиотеку (диск + БД + общее облако). */
async function saveToLibrary(result, { title, aspect, createdBy }) {
  await fsp.mkdir(VIDEO_DIR, { recursive: true });
  const fname = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.mp4`;
  const abs = path.join(VIDEO_DIR, fname);
  await fsp.copyFile(result.path, abs);
  const size = (await fsp.stat(abs)).size;
  let videoId = null;
  const pool = db();
  if (pool) {
    const ins = await pool.query(
      `INSERT INTO ai_video_library (title, storage_path, aspect, duration_sec, clips, size_bytes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [title || 'Промо-ролик', path.join('video', fname), aspect, result.durationSec, result.clips, size, createdBy || null]);
    videoId = ins.rows[0].id;
  }
  if (fileStore.shared()) {
    try { await fileStore.put(path.join('video', fname), await fsp.readFile(abs), 'video/mp4'); }
    catch (e) { console.error('[ai-video] cloud upload failed (локальная копия есть):', e.message); }
  }
  return { videoId, savedPath: abs };
}

/** Монтаж из СВОИХ видео: 1..N клипов + титры → один промо-MP4.
 *  mode=reel (за замовч.) — «Reels-магія»: fill-кроп, xfade+fadewhite, цвет,
 *  озвучка «напівшепіт» (voiceText), музыка (файл music) с дакингом.
 *  mode=simple — старая простая склейка с полями.
 *  async=1 → { job } сразу, поллинг GET /montage-job/:id (на проде рендер >100с
 *  рвался прокси — поэтому асинхронно). Без async — старое sync-поведение (simple). */
const { requireFeature } = require('../lib/feature-gate');
router.post('/montage', canRead, requireFeature('video_studio'), (req, res) => {
  uploadClips(req, res, async (upErr) => {
    if (upErr) {
      const code = upErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(code).json({ error: upErr.code === 'LIMIT_FILE_SIZE'
        ? `файл завеликий (макс 80 МБ на кліп)` : upErr.message });
    }
    const files = (req.files && req.files.clips) || [];
    const musicFile = ((req.files && req.files.music) || [])[0] || null;
    if (!files.length) { rmUploads(req); return res.status(400).json({ error: 'no clips uploaded' }); }
    let scenes = [];
    try { scenes = req.body.scenes ? JSON.parse(req.body.scenes) : []; } catch { scenes = []; }
    if (!Array.isArray(scenes)) scenes = [];
    const aspect = (req.body.aspect || '9:16').toString();
    const mode = (req.body.mode || 'reel').toString();
    const isAsync = req.body.async === '1' || req.query.async === '1';
    const createdBy = (req.staff && req.staff.name) || (req.user && req.user.name) || null;
    const title = (scenes[0] && scenes[0].caption) ? String(scenes[0].caption).slice(0, 120)
      : String(req.body.title || 'Промо-ролик').slice(0, 120);

    const renderOnce = async (onProgress) => {
      const clipList = files.map((f) => ({ path: f.path, name: f.originalname }));
      if (mode === 'simple') {
        const bufs = [];
        for (const f of files) bufs.push({ buffer: await fsp.readFile(f.path), name: f.originalname });
        return montager.montage(bufs, scenes, { aspect });
      }
      return reel.renderReel(clipList, {
        aspect,
        targetSec: req.body.targetSec,
        captions: scenes.map((s) => (s && s.caption) || ''),
        brandLine: req.body.brandLine || '',
        voiceText: req.body.voiceText || '',
        musicPath: musicFile ? musicFile.path : null,
        onProgress,
      });
    };

    if (isAsync) {
      const jobId = crypto.randomUUID();
      const job = { status: 'rendering', stage: 'Готуюсь…', error: null, videoId: null, createdAt: Date.now() };
      jobs.set(jobId, job);
      res.json({ ok: true, job: jobId });
      // Контекст тенанта (AsyncLocalStorage) сохраняется в этой async-цепочке —
      // запись в ai_video_library идёт под тем же tenant, что и запрос.
      (async () => {
        let result = null;
        try {
          result = await renderOnce((st) => { job.stage = st; });
          job.stage = 'Зберігаю в бібліотеку…';
          const saved = await saveToLibrary(result, { title, aspect, createdBy });
          job.videoId = saved.videoId;
          job.status = 'done';
        } catch (e) {
          console.error('[ai-video] reel job:', e.message);
          job.status = 'error';
          job.error = /відео|clips|max |монтувати/i.test(e.message) ? e.message : 'рендер не вдався — спробуйте ще раз';
        } finally {
          if (result) result.cleanup();
          rmUploads(req);
        }
      })();
      return;
    }

    // sync (старый путь — совместимость)
    let result = null;
    try {
      result = await renderOnce(() => {});
      let savedPath = result.path, videoId = null;
      try {
        const saved = await saveToLibrary(result, { title, aspect, createdBy });
        savedPath = saved.savedPath; videoId = saved.videoId;
      } catch (saveErr) { console.error('[ai-video] save library:', saveErr.message); }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="svs-promo.mp4"');
      res.setHeader('X-Montage-Duration', String(result.durationSec));
      res.setHeader('X-Montage-Clips', String(result.clips));
      if (videoId) res.setHeader('X-Video-Id', String(videoId));
      const stream = fs.createReadStream(savedPath);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.on('close', () => { result.cleanup(); rmUploads(req); });
      stream.pipe(res);
    } catch (e) {
      if (result) result.cleanup();
      rmUploads(req);
      if (/відео|clips|max |монтувати|nothing/i.test(e.message)) {
        console.error('[ai-video] montage:', e.message);
        return res.status(400).json({ error: e.message });
      }
      fail(res, e, 'montage');
    }
  });
});

/** Статус асинхронного рендера. */
router.get('/montage-job/:id', canRead, (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job-not-found' });
  res.json({ status: j.status, stage: j.stage, error: j.error, video_id: j.videoId });
});

/** Бібліотека збережених роликів — щоб після оновлення сторінки вони не зникали. */
router.get('/library', canRead, async (req, res) => {
  try {
    const pool = db();
    if (!pool) return res.json({ items: [] });
    const r = await pool.query(
      `SELECT id, title, aspect, duration_sec, clips, size_bytes, created_by, created_at
         FROM ai_video_library ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: r.rows });
  } catch (e) { fail(res, e, 'library'); }
});

/** Віддача збереженого ролика (з підтримкою Range — щоб <video> перемотувався). */
router.get('/file/:id', canRead, async (req, res) => {
  try {
    const pool = db();
    if (!pool) return res.status(404).json({ error: 'not-found' });
    const r = await pool.query(`SELECT storage_path FROM ai_video_library WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    const abs = path.join(UPLOAD_ROOT, r.rows[0].storage_path);
    if (!abs.startsWith(UPLOAD_ROOT)) return res.status(410).json({ error: 'file-gone' });
    if (!fs.existsSync(abs)) {
      // Файла нет локально — тянем из общего облака и кладём в локальный кэш.
      if (!fileStore.shared()) return res.status(410).json({ error: 'file-gone' });
      try {
        const buf = await fileStore.getBuffer(r.rows[0].storage_path);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
      } catch { return res.status(410).json({ error: 'file-gone' }); }
    }
    const stat = fs.statSync(abs);
    const range = req.headers.range;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range) || [];
      const start = parseInt(m[1], 10) || 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
  } catch (e) { fail(res, e, 'file'); }
});

/** Видалити ролик із бібліотеки (запис + файл). */
router.delete('/library/:id', canWrite, async (req, res) => {
  try {
    const pool = db();
    if (!pool) return res.status(404).json({ error: 'not-found' });
    const r = await pool.query(`DELETE FROM ai_video_library WHERE id=$1 RETURNING storage_path`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    const abs = path.join(UPLOAD_ROOT, r.rows[0].storage_path);
    if (abs.startsWith(UPLOAD_ROOT)) await fsp.rm(abs, { force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'library-delete'); }
});

module.exports = router;
