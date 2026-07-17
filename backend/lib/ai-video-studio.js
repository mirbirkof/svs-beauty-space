/* lib/ai-video-studio.js — VID-01 AI Video Studio.
   Серверная генерация промо-видео БЕЗ Mac — функциональный аналог PalmierPro
   поверх облачных моделей Google: Veo (видео) + Nano Banana/Imagen (кадры).
   Конвейер: brief → раскадровка (LLM, lib/llm) → ключевые кадры (Nano Banana)
             → видео-клипы (Veo, long-running) → метаданные/подпись/хештеги.

   КЛЮЧИ:
     - Текст раскадровки → lib/llm.js (бесплатный free-tier Gemini, как остальной AI CRM).
     - Кадры и видео (Veo) → ПЛАТНАЯ услуга Google. Берём ключ GEMINI_VIDEO_KEY;
       если не задан — пробуем GEMINI_API_KEY (на free-tier вернётся paid_key_required).
   Никаких сырых данных клиентов в промптах → инъекций нет. Промпт строит салон/AI.
   Модуль НИКОГДА не кидает сырое наружу в роут — роут сам решает по {error}. */
const https = require('https');
const llm = require('./llm');

const HOST = 'generativelanguage.googleapis.com';
// Veo: быстрый и дешёвый по умолчанию; качество — отдельной моделью при желании.
const VIDEO_MODEL = process.env.VEO_MODEL || 'veo-3.0-fast-generate-001';
const IMAGE_MODEL = process.env.NANO_MODEL || 'gemini-2.5-flash-image';

/** Ключ для платной генерации (видео/кадры). Отдельный от текстового — чтобы
 *  платный биллинг не смешивался с бесплатным текстовым бакетом других ботов. */
function videoKey() {
  return process.env.GEMINI_VIDEO_KEY || process.env.GEMINI_API_KEY || null;
}

/** Сырой HTTPS POST/GET к Gemini REST. Возвращает {status, json}. Не бросает на не-2xx. */
function _req(method, path, bodyObj, timeout = 30000) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: HOST, path, method, headers, timeout }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : {}; } catch { json = { _raw: d }; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('gemini timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

/** 429/квота/биллинг → единый маркер, чтобы роут отдал понятный 402, а не 500. */
function _isQuota(status, json) {
  const m = (json && json.error && json.error.message) || '';
  return status === 429 || /quota|billing|RESOURCE_EXHAUSTED|exceeded/i.test(m);
}

/* ── 1. Раскадровка (бесплатно, через общий llm.js) ─────────────
   Из короткого брифа делает структурированный сценарий: сцены с визуальными
   промптами под генерацию кадра/клипа, голос за кадром, подпись и хештеги. */
async function storyboard(brief, { scenes = 3, aspect = '9:16', lang = 'uk', brandVoice = '' } = {}) {
  if (!brief || !String(brief).trim()) throw new Error('brief required');
  const sys = `Ти — режисер коротких рекламних відео для салону краси. Повертай ЛИШЕ валідний JSON.`;
  const prompt = `Створи розкадровку рекламного ролика для Instagram Reels.
Бриф: "${String(brief).trim()}"
Кількість сцен: ${scenes}. Орієнтація: ${aspect} (вертикальне відео).
Мова озвучки/підпису: ${lang}. ${brandVoice ? 'Тон бренду: ' + brandVoice : ''}

Поверни JSON строго такої форми:
{
  "title": "коротка назва ролика",
  "scenes": [
    { "prompt": "детальний ВІЗУАЛЬНИЙ опис кадру англійською для генерації відео (камера, світло, обʼєкт, настрій, без тексту на екрані)",
      "narration": "1 коротка фраза озвучки мовою ${lang}",
      "durationSec": 5 }
  ],
  "caption": "підпис до посту мовою ${lang}, до 400 символів",
  "hashtags": ["до 7 релевантних хештегів"]
}`;
  const j = await llm.askJSON(prompt, { system: sys, maxTokens: 1600 });
  if (!j || !Array.isArray(j.scenes)) throw new Error('storyboard parse failed');
  // нормализация: durationSec в допустимый диапазон Veo (4-8с)
  j.scenes = j.scenes.slice(0, scenes).map((s) => ({
    prompt: String(s.prompt || '').slice(0, 800),
    narration: String(s.narration || '').slice(0, 200),
    durationSec: Math.min(8, Math.max(4, parseInt(s.durationSec, 10) || 6)),
  }));
  j.hashtags = Array.isArray(j.hashtags) ? j.hashtags.slice(0, 7) : [];
  return j;
}

/* ── 2. Ключевой кадр (платно: Nano Banana) ─────────────────────
   Возвращает {mime, base64} или {error:'paid_key_required'} при исчерпании квоты. */
async function generateFrame(prompt, { aspect = '9:16' } = {}) {
  const key = videoKey();
  if (!key) return { error: 'paid_key_required', reason: 'no GEMINI_VIDEO_KEY/GEMINI_API_KEY' };
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  const path = `/v1beta/models/${IMAGE_MODEL}:generateContent?key=${key}`;
  const { status, json } = await _req('POST', path, {
    contents: [{ parts: [{ text: `${prompt}. Aspect ratio ${aspect}, photorealistic, professional beauty salon promo, no text overlay.` }] }],
  }, 60000);
  if (_isQuota(status, json)) return { error: 'paid_key_required', reason: (json.error && json.error.message) || 'quota' };
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts || [];
  const img = parts.find((p) => p.inlineData && p.inlineData.data);
  if (img) return { mime: img.inlineData.mimeType || 'image/png', base64: img.inlineData.data };
  throw new Error((json.error && json.error.message) || `frame empty (status ${status})`);
}

/* ── 3. Видео-клип (платно: Veo, long-running) ──────────────────
   Запускает генерацию и возвращает {operation} — имя операции для поллинга.
   Опционально image (base64+mime) как стартовый кадр (image-to-video). */
async function startClip(prompt, { aspect = '9:16', durationSec = 6, image = null } = {}) {
  const key = videoKey();
  if (!key) return { error: 'paid_key_required', reason: 'no GEMINI_VIDEO_KEY/GEMINI_API_KEY' };
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  const instance = { prompt: String(prompt).slice(0, 800) };
  // image-to-video: Gemini API ждёт inlineData {mimeType,data}, НЕ bytesBase64Encoded (то формат Vertex).
  if (image && image.base64) instance.image = { inlineData: { mimeType: image.mime || 'image/png', data: image.base64 } };
  const path = `/v1beta/models/${VIDEO_MODEL}:predictLongRunning?key=${key}`;
  // Только задокументированные параметры Gemini API: aspectRatio + durationSeconds.
  // personGeneration тут НЕ поддерживается (это Vertex) → лишний параметр = 400.
  const { status, json } = await _req('POST', path, {
    instances: [instance],
    parameters: { aspectRatio: aspect, durationSeconds: String(Math.min(8, Math.max(4, durationSec))) },
  }, 60000);
  if (_isQuota(status, json)) return { error: 'paid_key_required', reason: (json.error && json.error.message) || 'quota' };
  if (json && json.name) return { operation: json.name };
  throw new Error((json.error && json.error.message) || `veo start failed (status ${status})`);
}

/** Проверить статус операции Veo. {done:false} | {done:true, videoUri} | {error}. */
async function pollClip(operation) {
  const key = videoKey();
  if (!key) return { error: 'paid_key_required' };
  if (!operation) throw new Error('operation required');
  // operation приходит с клиента → пускаем в URL только строгий формат имени
  // операции Veo, иначе можно дёрнуть произвольный путь Google API (path-injection).
  if (!/^models\/[\w.-]+\/operations\/[\w-]+$/.test(operation)) throw new Error('invalid operation');
  const { status, json } = await _req('GET', `/v1beta/${operation}?key=${key}`, null, 30000);
  if (_isQuota(status, json)) return { error: 'paid_key_required' };
  if (!json.done) return { done: false };
  // готово: вытащить URI видео (его скачивают добавив ?key=)
  const resp = json.response || {};
  const sample = (resp.generateVideoResponse && resp.generateVideoResponse.generatedSamples && resp.generateVideoResponse.generatedSamples[0])
    || (resp.generatedSamples && resp.generatedSamples[0]) || null;
  const uri = sample && sample.video && (sample.video.uri || sample.video.url);
  if (uri) return { done: true, videoUri: uri };
  if (json.error) return { error: json.error.message || 'veo failed' };
  return { done: true, raw: json.response || null };
}

/* ── 4. Оркестратор: бриф → готовый пакет ───────────────────────
   Всегда отдаёт бесплатную часть (сценарий+подпись+хештеги). Если есть платный
   ключ и render=true — дополнительно стартует Veo-клипы по сценам и возвращает
   операции для поллинга. Без ключа video.status='paid_key_required' — но текст
   уже на руках, ценность есть сразу. */
async function produce(brief, { scenes = 3, aspect = '9:16', lang = 'uk', brandVoice = '', render = false } = {}) {
  const board = await storyboard(brief, { scenes, aspect, lang, brandVoice });
  const out = { title: board.title, scenes: board.scenes, caption: board.caption, hashtags: board.hashtags, video: { status: 'storyboard_only' } };
  if (!render) return out;
  if (!videoKey()) { out.video = { status: 'paid_key_required' }; return out; }
  // Сцены независимы → стартуем все клипы Veo параллельно. Падение одной сцены
  // НЕ должно рушить весь пакет (иначе теряем уже стартовавшие клипы), поэтому
  // throw каждой ловим в её же error — частичный успех лучше общего 500.
  const started = await Promise.all(board.scenes.map((sc) =>
    startClip(sc.prompt, { aspect, durationSec: sc.durationSec }).catch((e) => ({ error: e.message }))));
  if (started.some((s) => s.error === 'paid_key_required')) { out.video = { status: 'paid_key_required' }; return out; }
  const ops = started.map((s, i) => ({ prompt: board.scenes[i].prompt, operation: s.operation || null, error: s.error || null }));
  const anyStarted = ops.some((o) => o.operation);
  out.video = anyStarted
    ? { status: 'rendering', operations: ops, hint: 'опитуй GET /api/ai/video/clip?operation=... поки done=true' }
    : { status: 'failed', operations: ops, error: 'жодну сцену не вдалося запустити' };
  return out;
}

/** Сводка возможностей — что реально доступно прямо сейчас. */
function readiness() {
  const paid = !!process.env.GEMINI_VIDEO_KEY;
  const anyKey = !!videoKey();
  return {
    storyboard: llm.available(),          // текст — бесплатно
    frames: anyKey,                       // картинки — нужен ключ (платный бакет)
    video: anyKey,                        // Veo — нужен платный ключ
    paid_key_configured: paid,            // отдельный платный ключ задан?
    video_model: VIDEO_MODEL,
    image_model: IMAGE_MODEL,
    note: paid ? 'ready' : 'set GEMINI_VIDEO_KEY (платный Google AI billing) для кадров и видео',
  };
}

/* ── Контент-план (Босс 17.07.2026) ──────────────────────────────
   Маркетолог-планировщик: бриф салона → N идей роликов, каждая со сценарием,
   ЗАДАЧАМИ НА СЪЁМКУ для админа простым языком, текстом озвучки, настроением
   музыки и советом по трендовому звуку.
   Жёсткое правило (Босс): трендова музика БУДЬ-ЯКА світова чи українська,
   але НІКОЛИ російська — ми в Україні. */
async function contentPlan(brief, { posts = 3, lang = 'uk', brandVoice = '' } = {}) {
  if (!brief || !String(brief).trim()) throw new Error('brief required');
  posts = Math.min(7, Math.max(1, parseInt(posts, 10) || 3));
  const sys = `Ти — SMM-стратег українських салонів краси. Повертай ЛИШЕ валідний JSON. Трендові звуки/музику пропонуй будь-які світові чи українські, але НІКОЛИ російські (артисти, пісні, звуки рф заборонені).`;
  const prompt = `Склади контент-план із ${posts} Reels для салону краси в Україні.
Про салон/бриф: "${String(brief).trim()}" ${brandVoice ? '· Тон бренду: ' + brandVoice : ''}
Кожен ролик: 3-4 сцени по 3-5 секунд, знімає АДМІНІСТРАТОР на телефон (прості завдання!).

Поверни JSON строго такої форми:
{"items":[{
  "idea": "коротка назва/ідея ролика",
  "publish_offset_days": 0,
  "scenario": {
    "scenes": [{ "narration": "коротка фраза озвучки українською", "shootHint": "просте завдання адміну: що і як зняти (ракурс, тривалість 3-5с)", "durationSec": 4 }],
    "caption": "підпис до посту українською до 300 символів",
    "hashtags": ["до 6 хештегів"],
    "voiceText": "суцільний текст озвучки з narration, з паузами через …",
    "voiceStyle": "female_soft | female_energy | male_calm — під психологію ЦА ролика",
    "musicMood": "tender | upbeat | luxury",
    "trendSoundAdvice": "порада: який трендовий звук знайти в Instagram під цей ролик (будь-який світовий/український тренд, НЕ російський)"
  }
}]}`;
  const j = await llm.askJSON(prompt, { system: sys, maxTokens: 2400 });
  if (!j || !Array.isArray(j.items) || !j.items.length) throw new Error('content plan parse failed');
  const MOODS = ['tender', 'upbeat', 'luxury'];
  const VOICES = ['female_soft', 'female_energy', 'male_calm'];
  return j.items.slice(0, posts).map((it) => {
    const sc = it.scenario || {};
    return {
      idea: String(it.idea || 'Ролик').slice(0, 200),
      publish_offset_days: Math.max(0, parseInt(it.publish_offset_days, 10) || 0),
      scenario: {
        scenes: (Array.isArray(sc.scenes) ? sc.scenes : []).slice(0, 6).map((s) => ({
          narration: String(s.narration || '').slice(0, 160),
          shootHint: String(s.shootHint || '').slice(0, 300),
          durationSec: Math.min(8, Math.max(2, parseInt(s.durationSec, 10) || 4)),
        })),
        caption: String(sc.caption || '').slice(0, 500),
        hashtags: (Array.isArray(sc.hashtags) ? sc.hashtags : []).slice(0, 7).map(String),
        voiceText: String(sc.voiceText || '').slice(0, 600),
        voiceStyle: VOICES.includes(sc.voiceStyle) ? sc.voiceStyle : 'auto',
        musicMood: MOODS.includes(sc.musicMood) ? sc.musicMood : 'tender',
        trendSoundAdvice: String(sc.trendSoundAdvice || '').slice(0, 300),
      },
    };
  });
}

module.exports = { storyboard, produce, generateFrame, startClip, pollClip, readiness, videoKey, contentPlan };
