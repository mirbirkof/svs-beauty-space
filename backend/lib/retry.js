// Універсальний retry з експоненційним backoff для вихідних інтеграцій
// (Telegram/Mono/SMS): при 429/5xx/timeout/мережевій помилці не втрачаємо
// повідомлення про оплату, а повторюємо. 4xx (крім 429) — НЕ ретраїмо (це
// помилка запиту, повтор не допоможе). Джиттер прибирає "громовий табун".
//
// Використання:
//   const { withRetry } = require('./retry');
//   await withRetry(() => monoRequest('POST', path, body), { label: 'mono' });

function isRetryable(err) {
  const code = err && (err.statusCode || err.status);
  if (code === 429) return true;                      // rate limit
  if (code && code >= 500 && code < 600) return true; // серверна помилка
  if (code && code >= 400 && code < 500) return false;// решта 4xx — не ретраїмо
  const m = String((err && err.message) || '').toLowerCase();
  // мережеві/таймаут помилки без statusCode
  return /timeout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|aborted/.test(m);
}

async function withRetry(fn, { tries = 3, baseDelay = 400, maxDelay = 5000, label = 'op', onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === tries || !isRetryable(e)) break;
      // exp backoff + джиттер (0..250мс)
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)) + Math.floor(((attempt * 97) % 25) * 10);
      if (typeof onRetry === 'function') { try { onRetry(attempt, e, delay); } catch (_) {} }
      else console.warn(`[retry:${label}] спроба ${attempt}/${tries} впала (${String(e.message || e).slice(0, 60)}), повтор через ${delay}мс`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable };
