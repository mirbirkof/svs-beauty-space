/* lib/llm.js — лёгкий LLM-клиент для AI-модулей CRM.
   Каскад: Gemini 2.5 Flash → OpenRouter → Groq.
   Емпірично перевірено на проді (Render datacenter IP):
     - Gemini 2.5-flash: працює, безкоштовно, окремий квота-бакет від 2.0-flash
       (яку вичерпує gemini-бот). thinkingBudget:0 щоб JSON не обрізався.
     - OpenRouter: працює з серверного IP, але кредит майже вичерпано → fallback.
     - Groq: блокує датацентрові IP ("Access denied") → лише локально, останній.
   Без сторонніх SDK — чистий https. Ніколи не кидає необроблене назовні:
   код, що викликає, сам вирішує що робити при null. */
const https = require('https');

function _post(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Gemini (generativelanguage REST) ───────────────────────
// gemini-2.5-flash: окремий квота-бакет від 2.0-flash (яку вичерпує gemini-бот),
// працює з датацентрового IP. thinkingBudget:0 — вимикаємо "мислення", інакше
// воно зʼїдає maxOutputTokens і JSON обрізається (finishReason MAX_TOKENS).
async function _gemini(prompt, { system, maxTokens = 2048, model = 'gemini-2.5-flash' } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
  });
  const { status, body: raw } = await _post({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${key}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 30000,
  }, body);
  const j = JSON.parse(raw);
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text) return text.trim();
  throw new Error(j.error?.message || `gemini empty (status ${status})`);
}

// ── Groq (OpenAI-совместимый) — fallback ───────────────────
async function _groq(prompt, { system, maxTokens = 2048, model = 'llama-3.3-70b-versatile' } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('no GROQ_API_KEY');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 });
  const { status, body: raw } = await _post({
    hostname: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) },
    timeout: 30000,
  }, body);
  const j = JSON.parse(raw);
  const text = j.choices?.[0]?.message?.content;
  if (text) return text.trim();
  throw new Error(j.error?.message || `groq empty (status ${status})`);
}

// ── OpenRouter (OpenAI-совместимый шлюз) — primary на проде ─
async function _openrouter(prompt, { system, maxTokens = 2048, model = 'meta-llama/llama-3.3-70b-instruct' } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('no OPENROUTER_API_KEY');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 });
  const { status, body: raw } = await _post({
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) },
    timeout: 30000,
  }, body);
  const j = JSON.parse(raw);
  const text = j.choices?.[0]?.message?.content;
  if (text) return text.trim();
  throw new Error(j.error?.message || `openrouter empty (status ${status})`);
}

/** Спросить LLM с авто-фолбэком. Возвращает строку или бросает если ВСЕ провайдеры упали. */
async function ask(prompt, opts = {}) {
  const errors = [];
  for (const [name, fn] of [['gemini', _gemini], ['openrouter', _openrouter], ['groq', _groq]]) {
    try { return await fn(prompt, opts); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  throw new Error('all LLM providers failed → ' + errors.join(' | '));
}

/** Спросить и распарсить JSON-ответ. Чистит markdown-обёртку ```json. null если не парсится. */
async function askJSON(prompt, opts = {}) {
  const raw = await ask(prompt, opts);
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'); const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function available() {
  return !!(process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
}

module.exports = { ask, askJSON, available };
