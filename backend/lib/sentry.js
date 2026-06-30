/* ═══════════════════════════════════════════════════════
   Sentry — мониторинг ошибок продакшна.
   Активируется ТОЛЬКО когда задан SENTRY_DSN (env Render).
   Без DSN — полный no-op: не грузит SDK, ничего не шлёт.
   Это позволяет задеплоить интеграцию заранее, а DSN
   вставить в env позже без правок кода.
   ═══════════════════════════════════════════════════════ */
let _Sentry = null;
let _enabled = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] disabled (no SENTRY_DSN)');
    return false;
  }
  try {
    _Sentry = require('@sentry/node');
    _Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || process.env.RENDER_SERVICE_NAME || 'production',
      release: process.env.RENDER_GIT_COMMIT || undefined,
      // Низкий сэмплинг трейсов — мониторим в первую очередь ошибки, не перфоманс.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE || 0.05),
      // Не слать тело запроса/заголовки с потенциальными секретами.
      sendDefaultPii: false,
    });
    _enabled = true;
    console.log('[sentry] enabled, env=' + (process.env.NODE_ENV || 'production'));
    return true;
  } catch (e) {
    console.error('[sentry] init failed:', e.message);
    _enabled = false;
    return false;
  }
}

// Захват исключения. Безопасно вызывать всегда — если выключен, ничего не делает.
function capture(err, context) {
  if (!_enabled || !_Sentry) return;
  try {
    if (context) _Sentry.captureException(err, { extra: context });
    else _Sentry.captureException(err);
  } catch (_) { /* мониторинг не должен ронять обработчик ошибок */ }
}

// Захват сообщения (для критичных не-Error событий: сбой cron, расхождение цифр).
function captureMessage(msg, level) {
  if (!_enabled || !_Sentry) return;
  try { _Sentry.captureMessage(msg, level || 'warning'); } catch (_) {}
}

function isEnabled() { return _enabled; }

module.exports = { init, capture, captureMessage, isEnabled };
