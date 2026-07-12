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
const { AsyncLocalStorage } = require('async_hooks');
const { getPool } = require('../db-pg');

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Контекст тенанта для всего async-дерева запроса (читает db-pg.js)
const tenantContext = new AsyncLocalStorage();
function getTenantId() {
  const store = tenantContext.getStore();
  return store ? store.tenantId : null;
}
// true только для оператора платформы (внутренний салон Босса).
// Используется для гард-доступа к супер-админ эндпоинтам SaaS.
function isPlatformTenant() {
  const store = tenantContext.getStore();
  return store ? !!store.isPlatform : false;
}

// slug → {id, status, is_internal}, кэш 5 мин
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function resolveBySlug(slug) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.tenant;
  const r = await getPool().query('SELECT id, status, is_internal FROM tenants WHERE slug = $1', [slug]);
  const tenant = r.rows[0] || null;
  cache.set(slug, { tenant, at: Date.now() });
  return tenant;
}

// Сбросить кэш статуса салона. ОБЯЗАТЕЛЬНО вызывать при смене tenants.status
// (оплата → active, неоплата → suspended), иначе салон до 5 мин висит в старом
// статусе: оплатил, но ещё заблокирован, или наоборот. Биллинг знает tenant_id,
// кэш по slug → ищем по id в (маленькой) карте.
function invalidateTenant({ slug, id } = {}) {
  if (slug) { cache.delete(slug); return; }
  if (id) {
    for (const [k, v] of cache) {
      if (v.tenant && v.tenant.id === id) cache.delete(k);
    }
  }
}

function tenantMiddleware() {
  return async function (req, res, next) {
    let slug = null;
    try {
      slug = req.headers['x-tenant-slug'] || null;
      if (!slug && process.env.TENANT_BASE_DOMAIN) {
        // сабдомен: {slug}.TENANT_BASE_DOMAIN → slug. Включается ТОЛЬКО на нашем
        // SaaS-домене (SAS-09). Иначе хосты платформ (svs-shop-api.onrender.com)
        // ошибочно резолвятся как slug → tenant-not-found на ВСЕХ запросах (баг 12.06).
        const host = String(req.headers.host || '').split(':')[0];
        const base = '.' + process.env.TENANT_BASE_DOMAIN;
        if (host.endsWith(base)) {
          const sub = host.slice(0, -base.length);
          if (sub && !sub.includes('.') && !['www', 'api'].includes(sub)) slug = sub;
        }
      }
      if (slug) {
        const t = await resolveBySlug(slug);
        if (!t) return res.status(404).json({ error: 'tenant-not-found' });
        if (t.status !== 'active') {
          // Заблокований салон (несплата) МУСИТЬ мати доступ до оплати, інакше глухий
          // кут: заблокований за борг, але заплатити не може → ніколи не розблокується.
          // Пускаємо лише маршрути біллингу/автентифікації у контексті тенанта; решту
          // CRM — 403. Оплата → вебхук Mono (без slug, не блокується) → салон active.
          const p = req.path || '';
          const billingRecovery = p === '/api/users/me'
            || p.startsWith('/api/auth')      // аудит v6: без входу суспенд-салон не міг
                                              //  отримати токен → не доходив до оплати (глухий кут)
            || p.startsWith('/api/billing')
            || p.startsWith('/api/pay');
          if (!billingRecovery) return res.status(403).json({ error: 'tenant-' + t.status, billing_blocked: true });
        }
        req.tenant_id = t.id;
        req.is_platform = !!t.is_internal;
      } else {
        // Без slug = прямой доступ оператора платформы (салон Босса).
        req.tenant_id = DEFAULT_TENANT_ID;
        req.is_platform = true;
      }
      tenantContext.run({ tenantId: req.tenant_id, isPlatform: req.is_platform }, next);
    } catch (e) {
      // FAIL-CLOSED: если резолв slug упал (был передан slug, но сбой БД) — НЕ
      // подставляем дефолтный тенант (это дало бы чужому салону контекст оператора
      // платформы). Возвращаем 503. Без slug (прямой доступ оператора Босса) —
      // дефолтный тенант как раньше: тут резолва нет, сбой невозможен.
      console.error('[tenant] resolve failed:', e.message);
      if (slug) return res.status(503).json({ error: 'tenant-resolve-failed' });
      req.tenant_id = DEFAULT_TENANT_ID;
      req.is_platform = true;
      tenantContext.run({ tenantId: DEFAULT_TENANT_ID, isPlatform: true }, next);
    }
  };
}

// Выполнить fn в контексте конкретного тенанта (для публичных эндпоинтов по slug,
// кронов и т.п. — db-pg.js прочитает app.tenant_id из этого контекста для RLS).
function runAs(tenantId, fn) {
  return tenantContext.run({ tenantId }, fn);
}

// ПРЕСЕЙЛ-БЛОКЕР #5: прогнать fn(tenantId) для КАЖДОГО живого салона под его RLS-контекстом.
// Кроны (постоянные расходы, Mono-скан, дни рождения) раньше делали один глобальный запрос
// без контекста → RLS permissive → данные всех салонов сваливались в дефолтный. Теперь крон
// оборачивается в forEachTenant, и все запросы внутри fn фильтруются по каждому тенанту.
// Список тенантов читаем вне tenant-контекста (runAs(null)), чтобы увидеть все строки.
// Ошибка в одном салоне не рвёт остальные — логируем и продолжаем.
async function forEachTenant(fn, { statuses = ['active', 'trial'] } = {}) {
  const { getPool } = require('../db-pg');
  const rows = await runAs(null, () =>
    getPool().query(`SELECT id FROM tenants WHERE status = ANY($1) ORDER BY created_at`, [statuses])
  ).then(r => r.rows).catch((e) => { console.error('[forEachTenant] list failed:', e.message); return []; });
  let ok = 0, fail = 0;
  for (const t of rows) {
    try { await runAs(t.id, () => fn(t.id)); ok++; }
    catch (e) { fail++; console.error(`[forEachTenant] tenant ${t.id} failed:`, e.message); }
  }
  return { tenants: rows.length, ok, fail };
}

module.exports = { tenantMiddleware, getTenantId, isPlatformTenant, resolveBySlug, invalidateTenant, runAs, forEachTenant, DEFAULT_TENANT_ID };
