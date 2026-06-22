/* ═══════════════════════════════════════════════════════
   INT-01 — API Gateway: аутентификация по API-ключу + rate limit
   Используется публичным API (routes/public-api.js).

   - ключ формата svs_live_<32hex>, хранится только sha256-хэш;
   - проверка scope (read / write / <ресурс>.read);
   - rate limit: скользящее окно 1 минута, лимит из api_keys.rate_limit_per_min;
   - tenant контекст: ключ привязан к tenant_id (для будущей мультиарендности).
   ═══════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { runAs } = require('./tenant');

function generateKey() {
  const raw = 'svs_live_' + crypto.randomBytes(24).toString('hex');
  return { raw, prefix: raw.slice(0, 16), hash: hashKey(raw) };
}
function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
function hasScope(scopes, required) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes('*') || scopes.includes('write')) return true;          // write покрывает read
  if (scopes.includes(required)) return true;
  if (required.endsWith('.read') && scopes.includes('read')) return true;     // общий read
  return false;
}

// in-memory rate limiter: keyId → { windowStart, count }
const buckets = new Map();
function checkRate(keyId, limit) {
  const now = Date.now();
  let b = buckets.get(keyId);
  if (!b || now - b.windowStart >= 60000) { b = { windowStart: now, count: 0 }; buckets.set(keyId, b); }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count),
           reset: Math.ceil((b.windowStart + 60000 - now) / 1000) };
}
// чистка старых бакетов раз в 5 мин
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.windowStart > 120000) buckets.delete(k);
}, 300000).unref?.();

// middleware-фабрика: apiKeyAuth('services.read')
function apiKeyAuth(requiredScope = 'read') {
  return async function (req, res, next) {
    try {
      const raw = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'api_key_required' });
      // Пошук ключа — БЕЗ тенант-контексту (runAs(null)): на цьому кроці ми ще не
      // знаємо салон, а tenantMiddleware вже поставив DEFAULT-тенанта Боса. Без цього
      // ключ чужого салону не знайшовся б (RLS відфільтрував би його), і запит мовчки
      // йшов би в салон Боса. null-контекст → db-pg обходить RLS лише для autentifікації.
      const rows = await runAs(null, () => getPool().query(
        `SELECT * FROM api_keys WHERE key_hash=$1 AND active=true LIMIT 1`, [hashKey(raw)]));
      const key = rows.rows[0];
      if (!key) return res.status(401).json({ error: 'invalid_api_key' });
      if (key.expires_at && new Date(key.expires_at) < new Date())
        return res.status(401).json({ error: 'api_key_expired' });
      if (!hasScope(key.scopes, requiredScope))
        return res.status(403).json({ error: 'insufficient_scope', need: requiredScope });

      const rl = checkRate(key.id, key.rate_limit_per_min || 120);
      res.set('X-RateLimit-Limit', String(key.rate_limit_per_min || 120));
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(rl.reset));
      if (!rl.allowed) return res.status(429).json({ error: 'rate_limit_exceeded', retry_after: rl.reset });

      req.apiKey = key;
      req.tenant_id = key.tenant_id;
      // Контекст тенанта КЛЮЧА на весь downstream: усі /api/v1/* читають/пишуть
      // салон власника ключа, а не DEFAULT Боса (audit #15). runAs ставить
      // app.tenant_id для RLS у db-pg. Для ключів Боса tenant_id = DEFAULT → без змін.
      runAs(key.tenant_id, () => {
        // best-effort облік використання (у контексті тенанта ключа)
        getPool().query(`UPDATE api_keys SET request_count=request_count+1, last_used_at=now() WHERE id=$1`, [key.id]).catch(() => {});
        next();
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

module.exports = { generateKey, hashKey, hasScope, apiKeyAuth };
