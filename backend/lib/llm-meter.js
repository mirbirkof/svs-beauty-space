/* lib/llm-meter.js — счётчик расхода AI и «отдых» для лежащих провайдеров.
 *
 * ЗАЧЕМ (задачи #7/#8, приём подсмотрен у Dify):
 *
 * 1) ОТДЫХ ЛЕЖАЩЕГО ПРОВАЙДЕРА. Каскад устроен «пробуй по очереди сверху».
 *    Когда у первого кончилась суточная квота, КАЖДЫЙ следующий вызов всё равно
 *    сначала стучится к нему, ждёт отказа (иногда до таймаута) и только потом
 *    идёт к рабочему. Это лишние секунды на каждой AI-функции CRM весь день.
 *    Здесь провайдер после отказа отправляется «отдыхать», и каскад его
 *    пропускает, пока срок не выйдет.
 *
 *    Срок зависит от КЛАССА ошибки — это важно, одна длительность для всего
 *    либо слишком груба, либо слишком мягка:
 *      • кончилась квота (429)      → 15 мин  (может быть и минутный лимит)
 *      • ключ не принят (401/403)   → 60 мин  (сам не починится, нужен человек)
 *      • сбой сети/сервера (5xx)    → 2 мин   (обычно временное)
 *      • прочее                     → не наказываем (ошибка могла быть в запросе,
 *                                     а не в провайдере — иначе спрячем свой же баг)
 *
 * 2) УЧЁТ РАСХОДА. Провайдеры возвращают количество токенов, но мы его выбрасывали,
 *    поэтому вопрос «сколько стоят AI-функции» оставался без ответа. Теперь каждый
 *    вызов пишется строкой в журнал: кто, сколько токенов, сколько миллисекунд,
 *    получилось или нет. Журнал самоограничен по размеру — не растёт бесконечно.
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'llm-usage.jsonl');
const LOG_MAX_BYTES = 2 * 1024 * 1024;      // 2 МБ — потом обрезаем половину

const COOLDOWN_MS = {
  quota: 15 * 60 * 1000,
  auth:  60 * 60 * 1000,
  server: 2 * 60 * 1000,
};

// провайдер -> { until, reason }
const resting = new Map();

/** По тексту/коду ошибки понять, за что наказывать (и наказывать ли вообще). */
function classify(err) {
  const m = String(err && err.message || err || '').toLowerCase();
  if (/429|quota|rate.?limit|resource.?exhausted|too many requests/.test(m)) return 'quota';
  if (/401|403|api key|unauthor|invalid.*key|permission denied|access denied/.test(m)) return 'auth';
  if (/timeout|econn|socket|network|5\d\d|internal error|unavailable|overloaded/.test(m)) return 'server';
  return null;                                 // не вина провайдера — не наказываем
}

/** Провайдер сейчас «отдыхает»? */
function isResting(name) {
  const r = resting.get(name);
  if (!r) return false;
  if (Date.now() >= r.until) { resting.delete(name); return false; }
  return true;
}

/** Отправить провайдера отдыхать по классу ошибки. Возвращает причину или null. */
function penalize(name, err) {
  const kind = classify(err);
  if (!kind) return null;
  const until = Date.now() + COOLDOWN_MS[kind];
  const prev = resting.get(name);
  // не сокращаем уже назначенный отдых (auth важнее, чем последующий server)
  if (prev && prev.until > until) return prev.reason;
  resting.set(name, { until, reason: kind });
  return kind;
}

/** Кто сейчас отдыхает и сколько осталось — для диагностики. */
function restingList() {
  const out = [];
  for (const [name, r] of resting) {
    const left = Math.max(0, Math.round((r.until - Date.now()) / 1000));
    if (left > 0) out.push({ provider: name, reason: r.reason, secondsLeft: left });
  }
  return out;
}

/** Достать расход токенов из ответа — форматы у провайдеров разные. */
function extractUsage(json) {
  if (!json || typeof json !== 'object') return null;
  const g = json.usageMetadata;                       // Gemini
  if (g) return { in: g.promptTokenCount || 0, out: g.candidatesTokenCount || 0 };
  const o = json.usage;                               // OpenAI-совместимые
  if (o) return { in: o.prompt_tokens || 0, out: o.completion_tokens || 0 };
  return null;
}

/** Записать факт вызова. Никогда не бросает — учёт не должен ронять бизнес-логику. */
function record(entry) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n'));
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* учёт молчит при любой проблеме с диском */ }
}

/** Сводка за N часов: сколько вызовов, токенов и отказов по каждому провайдеру. */
function summary(hours = 24) {
  try {
    if (!fs.existsSync(LOG_FILE)) return { since: hours, providers: {}, total: 0 };
    const since = Date.now() - hours * 3600 * 1000;
    const acc = {};
    let total = 0;
    for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (new Date(e.ts).getTime() < since) continue;
      total++;
      const a = acc[e.provider] || (acc[e.provider] = { calls: 0, fails: 0, tokensIn: 0, tokensOut: 0, ms: 0 });
      a.calls++;
      if (!e.ok) a.fails++;
      a.tokensIn += e.tokensIn || 0;
      a.tokensOut += e.tokensOut || 0;
      a.ms += e.ms || 0;
    }
    for (const a of Object.values(acc)) a.avgMs = a.calls ? Math.round(a.ms / a.calls) : 0;
    return { since: hours, total, providers: acc };
  } catch { return { since: hours, providers: {}, total: 0, error: true }; }
}

module.exports = { isResting, penalize, restingList, classify, extractUsage, record, summary };
