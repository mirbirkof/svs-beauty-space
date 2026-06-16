/* ── Safe error response helper ──────────────────────────
   In production: hides internal details (table names, SQL, paths, stack traces).
   In development: keeps full error for debugging.
   ─────────────────────────────────────────────────────── */
const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Return a client-safe error message.
 * @param {Error|string} err
 * @param {string} [fallback='Internal server error'] — generic message for production
 * @returns {string}
 */
function safeMessage(err, fallback = 'Internal server error') {
  if (!isProd()) return (err && err.message) || String(err) || fallback;
  return fallback;
}

/**
 * Build a JSON body suitable for sending to the client.
 * Keeps `error` code (slug), strips `detail` in production.
 * @param {string} errorCode — short slug like 'internal', 'np-failed'
 * @param {Error|string} err
 * @returns {object}
 */
function safeBody(errorCode, err) {
  const body = { error: errorCode };
  if (!isProd() && err) body.detail = (err && err.message) || String(err);
  return body;
}

module.exports = { safeMessage, safeBody, isProd };
