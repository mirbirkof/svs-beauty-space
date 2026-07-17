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

    // Клипы: загруженные сейчас + заранее сохранённые (staging, переживают F5).
    let stagedRows = [];
    try {
      const ids = req.body.staged_ids ? JSON.parse(req.body.staged_ids) : [];
      if (Array.isArray(ids) && ids.length && db()) {
        const r = await db().query(
          `SELECT id, file_name, storage_path FROM ai_video_staging WHERE id = ANY($1::bigint[])`, [ids.map(Number)]);
        const byId = new Map(r.rows.map((x) => [Number(x.id), x]));
        stagedRows = ids.map((id) => byId.get(Number(id))).filter(Boolean);
      }
    } catch (e) { console.error('[ai-video] staged_ids:', e.message); }

    const renderOnce = async (onProgress) => {
      const clipList = [
        ...stagedRows.map((s) => ({ path: path.join(UPLOAD_ROOT, s.storage_path), name: s.file_name })),
        ...files.map((f) => ({ path: f.path, name: f.originalname })),
      ];
      if (!clipList.length) throw new Error('no clips');
      if (mode === 'simple') {
        const bufs = [];
        for (const f of clipList) bufs.push({ buffer: await fsp.readFile(f.path), name: f.name });
        return montager.montage(bufs, scenes, { aspect });
      }
      // музыка: файл пользователя > настроение из библиотеки (CC BY, НЕ російська) > без музыки
      let musicPath = musicFile ? musicFile.path : null;
      if (!musicPath && req.body.musicMood) {
        const mood = String(req.body.musicMood).replace(/[^a-z_]/g, '');
        const cand = path.join(__dirname, '..', 'assets', 'music', `${mood}.mp3`);
        if (fs.existsSync(cand)) musicPath = cand;
      }
      return reel.renderReel(clipList, {
        aspect,
        targetSec: req.body.targetSec,
        captions: scenes.map((s) => (s && s.caption) || ''),
        brandLine: req.body.brandLine || '',
        voiceText: req.body.voiceText || '',
        voice: req.body.voice || 'auto',            // авто-подбор голоса под контент
        voiceContext: req.body.voiceContext || '',  // бриф/идея для психологии ЦА
        musicPath,
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

// ═══ STAGING — клипы, загруженные заранее (Босс 17.07) ══════════════════════
// Админ грузит видео СРАЗУ при выборе → они на сервере и переживают обновление
// страницы. Лишний клип можно удалить. Привязка к пункту контент-плана опциональна.
const STAGING_DIR = path.join(UPLOAD_ROOT, 'video-staging');

router.post('/staging', canRead, requireFeature('video_studio'), (req, res) => {
  uploadClips(req, res, async (upErr) => {
    if (upErr) {
      return res.status(upErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: upErr.code === 'LIMIT_FILE_SIZE' ? 'файл завеликий (макс 80 МБ)' : upErr.message });
    }
    const files = (req.files && req.files.clips) || [];
    if (!files.length) return res.status(400).json({ error: 'no clips' });
    const planItemId = req.body.plan_item_id ? Number(req.body.plan_item_id) : null;
    const createdBy = (req.user && req.user.display_name) || null;
    const out = [];
    try {
      await fsp.mkdir(STAGING_DIR, { recursive: true });
      for (const f of files) {
        const fname = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}${path.extname(f.originalname || '.mp4') || '.mp4'}`;
        const rel = path.join('video-staging', fname);
        await fsp.copyFile(f.path, path.join(UPLOAD_ROOT, rel));
        const size = (await fsp.stat(path.join(UPLOAD_ROOT, rel))).size;
        const ins = await db().query(
          `INSERT INTO ai_video_staging (plan_item_id, file_name, storage_path, size_bytes, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, file_name, size_bytes, plan_item_id, created_at`,
          [planItemId, String(f.originalname || fname).slice(0, 200), rel, size, createdBy]);
        out.push(ins.rows[0]);
      }
      res.json({ ok: true, items: out });
    } catch (e) { fail(res, e, 'staging'); }
    finally { rmUploads(req); }
  });
});

router.get('/staging', canRead, async (req, res) => {
  try {
    const cond = req.query.plan_item_id
      ? { sql: 'WHERE plan_item_id=$1', params: [Number(req.query.plan_item_id)] }
      : { sql: '', params: [] };
    const r = await db().query(
      `SELECT id, plan_item_id, file_name, size_bytes, created_by, created_at
         FROM ai_video_staging ${cond.sql} ORDER BY sort_order, id`, cond.params);
    res.json({ items: r.rows });
  } catch (e) { fail(res, e, 'staging-list'); }
});

router.delete('/staging/:id', canRead, async (req, res) => {
  try {
    const r = await db().query(`DELETE FROM ai_video_staging WHERE id=$1 RETURNING storage_path`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    const abs = path.join(UPLOAD_ROOT, r.rows[0].storage_path);
    if (abs.startsWith(UPLOAD_ROOT)) await fsp.rm(abs, { force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'staging-delete'); }
});

// ═══ КОНТЕНТ-ПЛАН (Босс 17.07) ══════════════════════════════════════════════
// AI-контентмейкер: бриф → план роликов с задачами на съёмку. Админ грузит клипы
// по задаче → «Змонтувати за сценарієм» → студия сама делает всё остальное.

/** Собрать реальный контекст салона для планировщика: профиль + Instagram +
 *  ТОП услуг по фактическим записям за 90 дней (план обязан соответствовать
 *  нише салона и его Instagram-странице, а не фантазиям — Босс 17.07). */
async function salonContextForPlan() {
  const parts = [];
  try {
    const { getSetting } = require('../lib/settings');
    const sp = (await getSetting('salon_profile', {})) || {};
    if (sp.name) parts.push(`Салон: ${sp.name}`);
    if (sp.instagram) parts.push(`Instagram: ${sp.instagram}`);
    if (sp.tiktok) parts.push(`TikTok: ${sp.tiktok}`);
    if (sp.facebook) parts.push(`Facebook: ${sp.facebook}`);
    if (sp.directions) parts.push(`Напрямки: ${sp.directions}`);
    if (sp.description) parts.push(`Опис: ${sp.description}`);
  } catch (_) {}
  try {
    const top = await db().query(
      `SELECT s.name, COUNT(*)::int n FROM appointments a JOIN services s ON s.id = a.service_id
        WHERE a.starts_at > NOW() - INTERVAL '90 days' AND a.status NOT IN ('cancelled','no_show')
        GROUP BY s.name ORDER BY n DESC LIMIT 10`);
    if (top.rows.length) parts.push('Найпопулярніші послуги (за реальними записами): ' + top.rows.map((r) => r.name).join(', '));
  } catch (e) { console.error('[ai-video] top services:', e.message); }
  return parts.join('\n');
}

router.post('/content-plan/generate', canRead, requireFeature('video_studio'), async (req, res) => {
  try {
    const { brief, posts, brandVoice } = req.body || {};
    const salonContext = await salonContextForPlan();
    const items = await studio.contentPlan(brief, { posts, brandVoice, salonContext });
    const saved = [];
    for (const it of items) {
      const d = new Date(Date.now() + it.publish_offset_days * 86400000);
      const ins = await db().query(
        `INSERT INTO ai_content_plan_items (publish_date, idea, scenario, shoot_tasks, status)
         VALUES ($1,$2,$3,$4,'plan') RETURNING *`,
        [d.toISOString().slice(0, 10), it.idea, JSON.stringify(it.scenario),
         JSON.stringify(it.scenario.scenes.map((s) => s.shootHint).filter(Boolean))]);
      saved.push(ins.rows[0]);
    }
    res.json({ ok: true, items: saved });
  } catch (e) { fail(res, e, 'content-plan-generate'); }
});

router.get('/content-plan', canRead, async (req, res) => {
  try {
    const r = await db().query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM ai_video_staging s WHERE s.plan_item_id=p.id) AS clips_uploaded
         FROM ai_content_plan_items p ORDER BY p.publish_date NULLS LAST, p.id DESC LIMIT 60`);
    res.json({ items: r.rows });
  } catch (e) { fail(res, e, 'content-plan-list'); }
});

router.delete('/content-plan/:id', canRead, async (req, res) => {
  try {
    await db().query(`DELETE FROM ai_video_staging WHERE plan_item_id=$1`, [req.params.id]);
    const r = await db().query(`DELETE FROM ai_content_plan_items WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'content-plan-delete'); }
});

/** Авто-монтаж пункта плана: клипы из staging + сценарий → готовый рил. */
router.post('/content-plan/:id/render', canRead, requireFeature('video_studio'), async (req, res) => {
  try {
    const it = (await db().query(`SELECT * FROM ai_content_plan_items WHERE id=$1`, [req.params.id])).rows[0];
    if (!it) return res.status(404).json({ error: 'not-found' });
    const clips = (await db().query(
      `SELECT file_name, storage_path FROM ai_video_staging WHERE plan_item_id=$1 ORDER BY sort_order, id`,
      [it.id])).rows;
    if (!clips.length) return res.status(400).json({ error: 'спочатку завантажте відео за завданнями зйомки' });
    const sc = it.scenario || {};
    const jobId = crypto.randomUUID();
    const job = { status: 'rendering', stage: 'Готуюсь…', error: null, videoId: null, createdAt: Date.now() };
    jobs.set(jobId, job);
    res.json({ ok: true, job: jobId });
    (async () => {
      let result = null;
      try {
        let musicPath = null;
        const mood = String(sc.musicMood || 'tender').replace(/[^a-z_]/g, '');
        const cand = path.join(__dirname, '..', 'assets', 'music', `${mood}.mp3`);
        if (fs.existsSync(cand)) musicPath = cand;
        result = await reel.renderReel(
          clips.map((c) => ({ path: path.join(UPLOAD_ROOT, c.storage_path), name: c.file_name })),
          {
            aspect: '9:16',
            targetSec: Math.min(60, (sc.scenes || []).reduce((s, x) => s + (x.durationSec || 4), 0) || 18),
            captions: (sc.scenes || []).map((s) => s.narration || ''),
            voiceText: sc.voiceText || '',
            voice: sc.voiceStyle && sc.voiceStyle !== 'auto' ? sc.voiceStyle : 'auto',
            voiceContext: it.idea,
            musicPath,
            onProgress: (st) => { job.stage = st; },
          });
        job.stage = 'Зберігаю в бібліотеку…';
        const saved = await saveToLibrary(result, { title: it.idea, aspect: '9:16',
          createdBy: (req.user && req.user.display_name) || null });
        job.videoId = saved.videoId;
        job.status = 'done';
        await db().query(`UPDATE ai_content_plan_items SET status='rendered', video_id=$1, updated_at=NOW() WHERE id=$2`,
          [saved.videoId, it.id]);
      } catch (e) {
        console.error('[ai-video] plan render:', e.message);
        job.status = 'error'; job.error = 'рендер не вдався — спробуйте ще раз';
      } finally { if (result) result.cleanup(); }
    })();
  } catch (e) { fail(res, e, 'content-plan-render'); }
});

// ═══ RETENTION — 3 дня (Босс 17.07) ═════════════════════════════════════════
// Готовый ролик должен скачиваться на устройство, а не жить в CRM: через 3 дня
// файл удаляется (место 0), запись остаётся в библиотеке как «архів» для статистики.
// Staging-клипы чистим через 7 дней (сырьё под съёмку недельного плана).
async function retentionTick() {
  try {
    const pool = db(); if (!pool) return;
    const old = await pool.query(
      `UPDATE ai_video_library SET archived_at=NOW()
        WHERE archived_at IS NULL AND created_at < NOW() - INTERVAL '3 days'
        RETURNING id, storage_path`);
    for (const r of old.rows) {
      const abs = path.join(UPLOAD_ROOT, r.storage_path);
      if (abs.startsWith(UPLOAD_ROOT)) await fsp.rm(abs, { force: true }).catch(() => {});
    }
    const oldStage = await pool.query(
      `DELETE FROM ai_video_staging WHERE created_at < NOW() - INTERVAL '7 days' RETURNING storage_path`);
    for (const r of oldStage.rows) {
      const abs = path.join(UPLOAD_ROOT, r.storage_path);
      if (abs.startsWith(UPLOAD_ROOT)) await fsp.rm(abs, { force: true }).catch(() => {});
    }
    if (old.rows.length || oldStage.rows.length) {
      console.log(`[ai-video] retention: архивировано ${old.rows.length} роликов, удалено ${oldStage.rows.length} staging-клипов`);
    }
  } catch (e) { console.error('[ai-video] retention:', e.message); }
}
setInterval(retentionTick, 6 * 3600 * 1000).unref();
setTimeout(retentionTick, 90 * 1000).unref();

/** Бібліотека збережених роликів — щоб після оновлення сторінки вони не зникали. */
router.get('/library', canRead, async (req, res) => {
  try {
    const pool = db();
    if (!pool) return res.json({ items: [] });
    const r = await pool.query(
      `SELECT id, title, aspect, duration_sec, clips, size_bytes, created_by, created_at, archived_at
         FROM ai_video_library ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: r.rows });
  } catch (e) { fail(res, e, 'library'); }
});

/** Віддача збереженого ролика (з підтримкою Range — щоб <video> перемотувався). */
router.get('/file/:id', canRead, async (req, res) => {
  try {
    const pool = db();
    if (!pool) return res.status(404).json({ error: 'not-found' });
    const r = await pool.query(`SELECT storage_path, archived_at FROM ai_video_library WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    // Retention: файл ролика живёт 3 дня (скачивайте сразу) — потом только запись для статистики
    if (r.rows[0].archived_at) return res.status(410).json({ error: 'archived', message: 'Ролик архівовано (файли зберігаються 3 дні) — завантажуйте результат одразу після рендеру.' });
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
