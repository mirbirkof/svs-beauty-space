/* lib/kb-embed.js — эмбеддинги для AI-05 Knowledge Base через Gemini gemini-embedding-001 (768-dim).
   Используется для семантического поиска (pgvector cosine). При недоступности/ошибке возвращает null —
   RAG-пайплайн тогда падает на полнотекстовый поиск (tsvector + pg_trgm), не ломаясь. */
const https = require('https');

const MODEL = 'gemini-embedding-001';
const DIMS = 768;

function available() { return !!process.env.GEMINI_API_KEY; }

/** Один embedContent-вызов. taskType: RETRIEVAL_DOCUMENT (индексация) | RETRIEVAL_QUERY (поиск). */
function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT', timeoutMs = 20000) {
  return new Promise((resolve) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !text) return resolve(null);
    const body = JSON.stringify({
      model: `models/${MODEL}`,
      content: { parts: [{ text: String(text).slice(0, 8000) }] },
      taskType,
      outputDimensionality: DIMS,
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:embedContent?key=${key}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const v = j.embedding && j.embedding.values;
          if (Array.isArray(v) && v.length) {
            // gemini-embedding-001 НЕ нормализует при <3072 dims → нормализуем для корректного cosine
            const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
            resolve(v.map((x) => x / norm));
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/** Эмбеддинги пачки текстов (ограниченный параллелизм, чтобы не упереться в rate limit). */
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT', concurrency = 4) {
  const out = new Array(texts.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      out[idx] = await embedOne(texts[idx], taskType);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}

/** Массив чисел → литерал pgvector '[a,b,c]' (или null). */
function toVectorLiteral(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return '[' + arr.map((x) => Number(x).toFixed(6)).join(',') + ']';
}

module.exports = { available, embedOne, embedBatch, toVectorLiteral, MODEL, DIMS };
