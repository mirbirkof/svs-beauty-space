/* BeautyPro warmer — каждые 60с прогревает services+masters в Postgres,
   чтобы публичные endpoint'ы могли отдавать из БД при шторме запросов.
   Не модифицирует существующие routes — отдельный фоновый процесс. */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const bp = require('../beautyproClient');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TICK_MS = 60 * 1000;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bp_cache (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function warmOnce() {
  const [services, employees] = await Promise.all([
    bp.listServices().catch(e => ({ error: e.message })),
    bp.listEmployees().catch(e => ({ error: e.message })),
  ]);
  if (!services.error) {
    await pool.query(
      `INSERT INTO bp_cache (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      ['services', JSON.stringify(services)]
    );
  }
  if (!employees.error) {
    await pool.query(
      `INSERT INTO bp_cache (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      ['employees', JSON.stringify(employees)]
    );
  }
  console.log(new Date().toISOString(), 'warmed', { services: !services.error, employees: !employees.error });
}

(async () => {
  await ensureTable();
  await warmOnce();
  setInterval(warmOnce, TICK_MS);
})().catch(e => { console.error(e); process.exit(1); });
