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
const meter = require('./llm-meter');   // учёт расхода + «отдых» лежащих провайдеров

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
async function _gemini(prompt, { system, maxTokens = 2048, model = 'gemini-2.5-flash', apiKey, usageBox } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
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
  // Расход токенов кладём в «конверт» из опций, а наружу отдаём ЧИСТУЮ строку —
  // вызывающий код (десятки мест в CRM) не должен ничего знать про учёт.
  if (usageBox) usageBox.usage = meter.extractUsage(j);
  if (text) return text.trim();
  throw new Error(j.error?.message || `gemini empty (status ${status})`);
}

// ── Groq (OpenAI-совместимый) — fallback ───────────────────
async function _groq(prompt, { system, maxTokens = 2048, model = 'llama-3.3-70b-versatile', apiKey, usageBox } = {}) {
  const key = apiKey || process.env.GROQ_API_KEY;
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
  if (usageBox) usageBox.usage = meter.extractUsage(j);
  if (text) return text.trim();
  throw new Error(j.error?.message || `groq empty (status ${status})`);
}

// ── OpenRouter (OpenAI-совместимый шлюз) — primary на проде ─
async function _openrouter(prompt, { system, maxTokens = 2048, model = 'meta-llama/llama-3.3-70b-instruct', apiKey, usageBox } = {}) {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
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
  if (usageBox) usageBox.usage = meter.extractUsage(j);
  if (text) return text.trim();
  throw new Error(j.error?.message || `openrouter empty (status ${status})`);
}

// Каскад провайдерів. Кілька Gemini-моделей підряд: у кожної free-tier СВІЙ
// денний квота-бакет, тож коли flash вичерпано — flash-lite ще живе (дає запас
// х2-3 без оплати). Далі OpenRouter і Groq як резерв.
const PROVIDERS = [
  ['gemini-2.5-flash',      (p, o) => _gemini(p, { ...o, model: 'gemini-2.5-flash' })],
  ['gemini-2.5-flash-lite', (p, o) => _gemini(p, { ...o, model: 'gemini-2.5-flash-lite' })],
  ['openrouter',            _openrouter],
  ['groq',                  _groq],
];

/** Спросить LLM с авто-фолбэком. Возвращает строку или бросает если ВСЕ провайдеры упали. */
// Пряме звернення до конкретного провайдера (для вибору «мозку» в налаштуваннях).
const PROVIDER_FNS = { gemini: _gemini, openrouter: _openrouter, groq: _groq };

async function ask(prompt, opts = {}) {
  // Якщо явно обрано провайдера (налаштування користувача) — пробуємо його першим,
  // потім падаємо у звичайний каскад (надійність важливіша за впертість).
  if (opts.provider && PROVIDER_FNS[opts.provider]) {
    // Учитываем и этот путь тоже: иначе вызовы с выбранным в настройках «мозгом»
    // проходили бы мимо журнала, и расход выглядел бы меньше реального.
    const t0 = Date.now(); const box = {};
    try {
      const text = await PROVIDER_FNS[opts.provider](prompt, { ...opts, usageBox: box });
      meter.record({ provider: opts.provider + ' (обраний)', ok: true, ms: Date.now() - t0,
                     tokensIn: box.usage?.in || 0, tokensOut: box.usage?.out || 0 });
      return text;
    } catch (e) {
      meter.record({ provider: opts.provider + ' (обраний)', ok: false, ms: Date.now() - t0,
                     error: String(e.message).slice(0, 120) });
      /* далі — каскад за замовчуванням */
    }
  }
  const errors = [];
  const skipped = [];
  for (const [name, fn] of PROVIDERS) {
    // Пропускаем «отдыхающих»: у кого недавно кончилась квота или не принят ключ.
    // Раньше каскад долбился в них при КАЖДОМ вызове и ждал отказа — лишние
    // секунды на каждой AI-функции, пока квота не восстановится.
    if (meter.isResting(name)) { skipped.push(name); continue; }
    const t0 = Date.now();
    const box = {};                 // «конверт» для расхода токенов этого вызова
    try {
      const text = await fn(prompt, { ...opts, usageBox: box });
      meter.record({ provider: name, ok: true, ms: Date.now() - t0,
                     tokensIn: box.usage?.in || 0, tokensOut: box.usage?.out || 0 });
      return text;
    } catch (e) {
      const punished = meter.penalize(name, e);
      meter.record({ provider: name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 120),
                     resting: punished || undefined });
      errors.push(`${name}: ${e.message}`);
    }
  }
  // Все отдыхают и пробовать было некого — честно говорим об этом, а не «все упали»
  if (!errors.length && skipped.length) {
    throw new Error(`all LLM providers resting (${skipped.join(', ')}) — квота/ключі, спробуйте пізніше`);
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
