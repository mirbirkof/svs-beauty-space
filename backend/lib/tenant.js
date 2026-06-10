/*
 * Tenant Context (SAS-01, этап 2) — определение тенанта на каждом запросе.
 *
 * Порядок резолва:
 *   1. Заголовок X-Tenant-Slug (для API-клиентов и тестов)
 *   2. Сабдомен: {slug}.домен (для SaaS-клиентов, этап с SAS-09)
 *   3. DEFAULT_TENANT_ID — салон Босса (обратная совместимость: весь текущий
 *      трафик работает как раньше, без каких-либо изменений в клиентах)
 *
 * Контракт для нового кода: каждый INSERT обязан писать req.tenant_id,
 * каждый SELECT — фильтровать по нему. Старый код работает через DEFAULT в схеме.
 */
const { getPool } = require('../db-pg');

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// slug → {id, status}, кэш 5 мин
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function resolveBySlug(slug) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.tenant;
  const r = await getPool().query('SELECT id, status FROM tenants WHERE slug = $1', [slug]);
  const tenant = r.rows[0] || null;
  cache.set(slug, { tenant, at: Date.now() });
  return tenant;
}

function tenantMiddleware() {
  return async function (req, res, next) {
    try {
      let slug = req.headers['x-tenant-slug'] || null;
      if (!slug) {
        // сабдомен: beauty.example.com → 'beauty' (www/api/localhost игнорируем)
        const host = String(req.headers.host || '').split(':')[0];
        const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost';
        const parts = host.split('.');
        if (!isIp && parts.length >= 3 && !['www', 'api'].includes(parts[0])) slug = parts[0];
      }
      if (slug) {
        const t = await resolveBySlug(slug);
        if (!t) return res.status(404).json({ error: 'tenant-not-found' });
        if (t.status !== 'active') return res.status(403).json({ error: 'tenant-' + t.status });
        req.tenant_id = t.id;
      } else {
        req.tenant_id = DEFAULT_TENANT_ID;
      }
      next();
    } catch (e) {
      // не валим запрос из-за сбоя резолва — фолбэк на дефолтный тенант
      req.tenant_id = DEFAULT_TENANT_ID;
      next();
    }
  };
}

module.exports = { tenantMiddleware, DEFAULT_TENANT_ID };
