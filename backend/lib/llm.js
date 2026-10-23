/* lib/llm.js — лёгкий LLM-клиент для AI-модулей CRM.
   23.10.2026 (аудит, п.1; правило системы «только Claude»): каскад ПО УМОЛЧАНИЮ = только Claude
   (CLI Claude Code по подписке — тот же канал, что у движка Jarvis). Gemini/OpenRouter/Groq остались
   в коде ТОЛЬКО как явный выбор салона в «Налаштування мозку» (ai_provider), в каскад не входят.
   Телефоны и email вырезаются из промпта и system ДО отправки любому провайдеру (lib/pii-mask.js),
   метки в ответе возвращаются в настоящие значения уже у нас.
   Без сторонніх SDK. Ніколи не кидає необроблене назовні: код, що викликає, сам вирішує що робити при null. */
const https = require('https');
const meter = require('./llm-meter');   // учёт расхода + «отдых» лежащих провайдеров
const fs = require('fs');
const { spawn } = require('child_process');
const { createMasker } = require('./pii-mask');

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

// ── Claude (CLI Claude Code, подписка) — основной и единственный по умолчанию ──
// Голый вызов: без инструментов, без MCP, без хуков/памяти Jarvis (пустая рабочая папка,
// setting-sources=local), 1 ход. Промпт идёт через stdin. Токен подписки читаем из файла движка
// в момент вызова (обновился — подхватится без рестарта CRM). Значение токена нигде не логируется.
const CLAUDE_BIN = process.env.CRM_CLAUDE_BIN || '/home/client/workspace/.npm-local/node_modules/.bin/claude';
const CLAUDE_TOKEN_FILE = process.env.CRM_CLAUDE_TOKEN_FILE || '/home/client/workspace/own-engine/.claude-oauth-token';
const CLAUDE_CWD = '/tmp/crm-claude-cwd';
const CLAUDE_MAX_PAR = 2;           // сервер 3.9 ГБ: один CLI ≈ 250 МБ — больше двух одновременно не пускаем
let _claudeActive = 0; const _claudeQueue = [];
function _claudeSlot() {
  if (_claudeActive < CLAUDE_MAX_PAR) { _claudeActive++; return Promise.resolve(); }
  return new Promise((r) => _claudeQueue.push(r));
}
function _claudeFree() { const n = _claudeQueue.shift(); if (n) n(); else _claudeActive--; }
function _claudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try { return fs.readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

async function _claude(prompt, { system, model = process.env.CRM_CLAUDE_MODEL || 'sonnet', usageBox, timeoutMs = 90000 } = {}) {
  const token = _claudeToken();
  if (!token) throw new Error('no claude token');
  if (!fs.existsSync(CLAUDE_BIN)) throw new Error('no claude cli');
  try { fs.mkdirSync(CLAUDE_CWD, { recursive: true }); } catch { /* есть */ }
  await _claudeSlot();
  try {
    return await new Promise((resolve, reject) => {
      const args = ['--print', '--output-format', 'json', '--model', model, '--max-turns', '1',
        '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'local',
        '--no-session-persistence'];
      if (system) args.push('--system-prompt', String(system));
      args.push('-');
      const env = { ...process.env, HOME: '/home/client', CLAUDE_CODE_OAUTH_TOKEN: token };
      delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.ANTHROPIC_API_KEY;
      let out = '', err = '', done = false;
      const child = spawn(CLAUDE_BIN, args, { cwd: CLAUDE_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} reject(new Error('LLM timeout')); } }, timeoutMs);
      child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
      child.on('close', (code) => {
        if (done) return; done = true; clearTimeout(timer);
        let j; try { j = JSON.parse(out); } catch { return reject(new Error(`claude bad output (exit ${code}) ${err.slice(0, 120)}`)); }
        if (usageBox && j.usage) usageBox.usage = { in: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), out: j.usage.output_tokens || 0 };
        const text = typeof j.result === 'string' ? j.result.trim() : '';
        if (j.is_error || !text) return reject(new Error(`claude: ${(text || j.subtype || 'empty').slice(0, 120)}`));
        if (/^API Error:\s*\d+/.test(text) && text.length < 300) return reject(new Error(text.slice(0, 120)));
        resolve(text);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(String(prompt));
    });
  } finally { _claudeFree(); }
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

// Каскад за замовчуванням — ТІЛЬКИ Claude (правило системи «тільки Claude», аудит 23.10).
// Sonnet → при збої Haiku. Безкоштовні Gemini/OpenRouter/Groq сюди НЕ повертати: туди йшли
// імена/нотатки клієнтів. Вони доступні лише як явний вибір у налаштуваннях (PROVIDER_FNS).
const PROVIDERS = [
  ['claude-sonnet', (p, o) => _claude(p, { ...o, model: 'sonnet' })],
  ['claude-haiku',  (p, o) => _claude(p, { ...o, model: 'haiku' })],
];

/** Спросить LLM с авто-фолбэком. Возвращает строку или бросает если ВСЕ провайдеры упали. */
// Пряме звернення до конкретного провайдера (для вибору «мозку» в налаштуваннях).
const PROVIDER_FNS = { claude: _claude, gemini: _gemini, openrouter: _openrouter, groq: _groq };

async function ask(prompt, opts = {}) {
  // Телефони/email → мітки ДО будь-якого провайдера; у відповіді мітки → справжні значення (локально).
  const masker = createMasker();
  const mp = masker.mask(prompt);
  const mopts = { ...opts, system: opts.system ? masker.mask(opts.system) : opts.system };
  const text = await _askRaw(mp, mopts);
  return masker.unmask(text);
}

async function _askRaw(prompt, opts = {}) {
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
  return !!_claudeToken() && fs.existsSync(CLAUDE_BIN);
}

module.exports = { ask, askJSON, available };
