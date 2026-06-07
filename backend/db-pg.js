/* ═══════════════════════════════════════════════════════
   SVS Beauty World — PostgreSQL connection pool
   Используется новыми роутами (catalog, crm, orders-v2).
   Старые роуты (auth, booking) пока на SQLite через db.js.
   ═══════════════════════════════════════════════════════ */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
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
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
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
