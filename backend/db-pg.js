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
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
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
    if (tid) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
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

function isEnabled() {
  return !!process.env.DATABASE_URL;
}

module.exports = { query, withTx, getPool, isEnabled };
