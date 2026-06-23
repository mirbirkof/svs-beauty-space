'use strict';
/**
 * lib/report-cache.js — TTL-кэш тяжёлых отчётов (аудит 23.06, #14).
 *
 * Проблема: дашборд/PnL/revenue-series гоняют тяжёлые агрегаты при каждом
 * открытии страницы. Под нагрузкой это лишние секунды и нагрузка на БД.
 *
 * Решение — безопасный по свежести кэш:
 *   • короткий TTL (по умолчанию 60с) → максимальная устарелость ограничена,
 *     финансовые цифры «отстают» максимум на минуту (приемлемо для отчётов);
 *   • per-tenant версия: при записи (закрытие записи и т.п.) версия тенанта
 *     инкрементится → все его кэши мгновенно протухают, не дожидаясь TTL;
 *   • bypass: ?fresh=1 в запросе всегда считает заново (для «обновить сейчас»);
 *   • кэш в памяти процесса, ключ = tenant:path:query. НЕ кэшируем POST/мутации.
 *
 * Денежные транзакции НЕ трогаются — инвалидация только через bumpTenant(),
 * который дёргается из шины событий (appointment.completed) и при желании
 * может вызываться из любого write-пути.
 */

const TTL_MS = Number(process.env.REPORT_CACHE_TTL_MS || 60000);
const MAX_ENTRIES = Number(process.env.REPORT_CACHE_MAX || 500);

const store = new Map();      // key -> { expires, version, body }
const tenantVersion = new Map(); // tenantId -> integer

function verOf(tenantId) {
  return tenantVersion.get(String(tenantId || 'default')) || 0;
}

/** Инвалидация всех кэшей тенанта (мгновенно протухают). */
function bumpTenant(tenantId) {
  const k = String(tenantId || 'default');
  tenantVersion.set(k, verOf(k) + 1);
}

function keyFor(req) {
  const tid = req.tenant_id || req.tenantId || (req.user && req.user.tenant_id) || 'default';
  // querystring сортируем, чтобы порядок параметров не плодил разные ключи
  const qs = Object.keys(req.query || {}).sort().map(k => `${k}=${req.query[k]}`).join('&');
  // ВАЖНО: некоторые отчёты (dashboard/overview) отдают РАЗНЫЙ объём данных в
  // зависимости от прав (reports.finance). Иначе юзер без финправ получит из
  // кэша ответ, посчитанный для финансиста → утечка. Кладём отпечаток прав в ключ.
  let hasFin = false;
  try { hasFin = require('./rbac').hasPermission((req.user && req.user.permissions) || [], 'reports.finance'); }
  catch (_) { const p = (req.user && req.user.permissions) || []; hasFin = Array.isArray(p) && (p.includes('*') || p.includes('reports.finance')); }
  const scope = hasFin ? 'fin' : 'base';
  return { tid, key: `${tid}::${scope}::${req.path}::${qs}` };
}

/** Чистка протухших + ограничение размера (грубый LRU по времени). */
function evictIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) { if (v.expires <= now) store.delete(k); }
  if (store.size <= MAX_ENTRIES) return;
  // всё ещё много — удаляем самые старые по expires
  const arr = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
  const drop = arr.slice(0, Math.ceil(arr.length * 0.2));
  for (const [k] of drop) store.delete(k);
}

/**
 * Express middleware. Кэширует JSON-ответ GET-эндпоинта на TTL_MS.
 * Перехватывает res.json: при первом вызове сохраняет тело, при попадании —
 * отдаёт из кэша с заголовком X-Cache: HIT.
 */
function cacheReport(ttlMs = TTL_MS) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.query && (req.query.fresh === '1' || req.query.nocache === '1')) {
      res.set('X-Cache', 'BYPASS');
      return next();
    }
    const { tid, key } = keyFor(req);
    const hit = store.get(key);
    const now = Date.now();
    if (hit && hit.expires > now && hit.version === verOf(tid)) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    // промах — перехватываем json, чтобы сохранить результат
    const origJson = res.json.bind(res);
    res.json = (body) => {
      // кэшируем только успешные ответы
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.set(key, { expires: Date.now() + ttlMs, version: verOf(tid), status: res.statusCode, body });
        evictIfNeeded();
      }
      res.set('X-Cache', 'MISS');
      return origJson(body);
    };
    next();
  };
}

// Авто-инвалидация: закрытие записи меняет выручку/загрузку → сбрасываем кэш тенанта.
try {
  const bus = require('./event-bus');
  bus.on('appointment.completed', (evt) => {
    const tid = (evt && (evt.tenant_id || (evt.payload && evt.payload.tenant_id))) || 'default';
    bumpTenant(tid);
  });
} catch (_) { /* шина не обязательна */ }

module.exports = { cacheReport, bumpTenant, TTL_MS, _store: store };
