/* ═══════════════════════════════════════════════════════
   SVS Beauty World — PostgreSQL connection pool
   Используется новыми роутами (catalog, crm, orders-v2).
   Старые роуты (auth, booking) пока на SQLite через db.js.
   ═══════════════════════════════════════════════════════ */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  // DATABASE_URL_APP — роль app_tenant БЕЗ BYPASSRLS (RLS реально работает).
  // DATABASE_URL (neondb_owner, bypassrls) остаётся для миграций/DDL-скриптов.
  const url = process.env.DATABASE_URL_APP || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL не задан — Postgres-роуты выключены');
  }
  pool = new Pool({
    connectionString: url,
    ssl: url.includes('neon.tech') || url.includes('supabase')
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[pg pool error]', err.message));

  // ── Tenant isolation (SAS-01 этап 2) ──
  // Если запрос идёт внутри HTTP-контекста тенанта (AsyncLocalStorage из lib/tenant),
  // каждый pool.query оборачивается в транзакцию с transaction-local GUC app.tenant_id —
  // RLS-политики (миграция 015) фильтруют строки на стороне Postgres.
  // Вне контекста (кроны, скрипты, миграции) — прямой запрос, RLS permissive.
  //
  // ВАЖНО (root-fix утечки тенантов 21.06): прод коннектится ролью с BYPASSRLS
  // (neondb_owner), которая ИГНОРИРУЕТ все RLS-политики → новый салон видел данные
  // соседей. Лечим переключением роли внутри транзакции на app_tenant (BYPASSRLS=off):
  // `SET LOCAL ROLE app_tenant` действует только до COMMIT/ROLLBACK, поэтому
  // следующий запрос из пула снова идёт под исходной ролью. Делаем это ТОЛЬКО когда
  // есть контекст тенанта — кроны/миграции/супер-админ (без tid) сохраняют полный доступ.
  startAppRoleProbe();
  const rawQuery = pool.query.bind(pool);
  pool.query = function (text, params, cb) {
    const tid = currentTenantId();
    // callback-стиль или config-объект — не оборачиваем (так не пишет наш код)
    if (!tid || typeof params === 'function' || typeof cb === 'function' || typeof text !== 'string') {
      return rawQuery(text, params, cb);
    }
    return (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await applyTenantOnClient(client, tid);
        const out = await client.query(text, params);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    })();
  };

  return pool;
}

// Имя ограниченной роли приложения (BYPASSRLS=off). Конфигурируемо на случай иных сред.
const APP_DB_ROLE = (process.env.DB_APP_ROLE || 'app_tenant').replace(/[^a-zA-Z0-9_]/g, '');
// null = ещё не проверяли, true/false = доступна ли роль текущему пользователю.
let appRoleAvailable = null;
// BYPASSRLS-атрибут самого пользователя подключения. Если true И app-роль недоступна —
// RLS не сработает совсем (#16): тогда при наличии тенанта запрос отклоняем (fail-closed),
// а не отдаём данные без изоляции. Аварийный обход: DB_ALLOW_UNSAFE_ISOLATION=1.
let connUserBypassesRls = null;
let appRoleProbe = null;

// Один раз проверяем: существует ли роль app_tenant и можем ли мы в неё переключиться.
// Если нет (локалка/dev без роли) — изоляция остаётся на уровне GUC+RLS как раньше,
// без падений запросов из-за `SET LOCAL ROLE`.
function startAppRoleProbe() {
  if (appRoleProbe) return appRoleProbe;
  appRoleProbe = (async () => {
    try {
      const r = await rawPoolQuery(
        `SELECT pg_has_role(current_user, $1, 'USAGE') AS ok,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
        [APP_DB_ROLE]
      );
      appRoleAvailable = !!(r.rows[0] && r.rows[0].ok);
      connUserBypassesRls = !!(r.rows[0] && r.rows[0].bypass);
      const mode = appRoleAvailable ? 'ON (' + APP_DB_ROLE + ')'
        : (connUserBypassesRls ? 'FAIL-CLOSED (role unavailable + BYPASSRLS user → tenant queries rejected)'
                               : 'RLS-only (non-bypass user)');
      console.log(`[pg] app-role isolation: ${mode}`);
    } catch (e) {
      appRoleAvailable = false;
      connUserBypassesRls = true; // неизвестно → считаем опасным, fail-closed
      console.warn('[pg] app-role probe failed → fail-closed for tenant queries:', e.message);
    }
  })();
  return appRoleProbe;
}

function rawPoolQuery(text, params) {
  // прямой запрос мимо обёртки pool.query (которая может быть переопределена)
  return Pool.prototype.query.call(pool, text, params);
}

// Внутри уже открытой транзакции: переключить роль на app_tenant (если доступна)
// и выставить transaction-local app.tenant_id для RLS.
async function applyTenantOnClient(client, tid) {
  if (appRoleAvailable === null && appRoleProbe) { try { await appRoleProbe; } catch (_) {} }
  if (appRoleAvailable) {
    await client.query('SET LOCAL ROLE ' + APP_DB_ROLE);
  } else if (connUserBypassesRls && process.env.DB_ALLOW_UNSAFE_ISOLATION !== '1') {
    // #16 fail-closed: app-роль недоступна, а пользователь подключения обходит RLS →
    // изоляция тенанта невозможна. Лучше отказать, чем отдать данные соседнего салона.
    throw new Error('tenant isolation unavailable: app role missing on BYPASSRLS connection');
  }
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
}

// ленивый импорт — lib/tenant.js сам требует db-pg (разрыв цикла)
function currentTenantId() {
  try {
    return require('./lib/tenant').getTenantId();
  } catch (_) {
    return null;
  }
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tid = currentTenantId();
    if (tid) await applyTenantOnClient(client, tid);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Выставляет transaction-local app.tenant_id на ВНЕШНЕМ client'е (для ручных
// транзакций в orders/inventory/cashbox, которые берут pool.connect() напрямую).
// Также переключает роль на app_tenant (BYPASSRLS=off), иначе RLS не изолирует под
// neondb_owner. No-op вне HTTP-контекста (кроны/скрипты) — поведение как раньше.
async function applyTenant(client) {
  const tid = currentTenantId();
  if (tid) await applyTenantOnClient(client, tid);
}

function isEnabled() {
  return !!process.env.DATABASE_URL;
}

module.exports = { query, withTx, applyTenant, getPool, isEnabled };
