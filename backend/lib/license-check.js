/*
 * SAS этап 2: быстрый гейт лицензий для горячих путей (онлайн-запись).
 * Салон платформы (Босс) лицензий не требует. Остальные — active/grace_period
 * лицензия модуля. Кэш 2 мин, чтобы не бить БД на каждый апдейт бота.
 */
const { getPool } = require('../db-pg');
const { DEFAULT_TENANT_ID } = require('./tenant');

const TTL = 2 * 60 * 1000;
const cache = new Map(); // `${tenantId}:${code}` → { ok, at }

async function isLicensed(tenantId, moduleCode) {
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return true;
  const key = tenantId + ':' + moduleCode;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  let ok = false;
  try {
    const r = await getPool().query(
      `SELECT 1 FROM licenses l
         JOIN module_catalog m ON m.id = l.module_id
        WHERE l.tenant_id = $1 AND m.code = $2
          AND l.status IN ('active','grace_period')
          AND (l.expires_at IS NULL OR l.expires_at > NOW() - interval '3 days')
        LIMIT 1`, [tenantId, moduleCode]);
    ok = !!r.rowCount;
  } catch (e) { console.error('[license-check]', e.message); ok = true; /* fail-open: не валимо запис через збій БД */ }
  cache.set(key, { ok, at: Date.now() });
  return ok;
}

function invalidateLicense(tenantId) {
  for (const k of cache.keys()) if (k.startsWith(tenantId + ':')) cache.delete(k);
}

module.exports = { isLicensed, invalidateLicense };
