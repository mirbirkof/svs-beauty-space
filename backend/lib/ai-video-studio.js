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
  if (image && image.base64) instance.image = { bytesBase64Encoded: image.base64, mimeType: image.mime || 'image/png' };
  const path = `/v1beta/models/${VIDEO_MODEL}:predictLongRunning?key=${key}`;
  const { status, json } = await _req('POST', path, {
    instances: [instance],
    parameters: { aspectRatio: aspect, durationSeconds: Math.min(8, Math.max(4, durationSec)), personGeneration: 'allow_adult' },
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

module.exports = { storyboard, generateFrame, startClip, pollClip, readiness, videoKey };
