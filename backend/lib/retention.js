/* lib/retention.js — авто-очистка растущих таблиц (outbox, логи, коды).
   Удаляет ТОЛЬКО устаревшие/обработанные записи. Запускается раз в сутки.
   Цель: данные не растут бесконтрольно на масштабе (10k+ событий/день). */
const { getPool } = require('../db-pg');

// [таблица, SQL-условие удаления]. Консервативные сроки — историю не трогаем рано.
const RULES = [
  ['domain_events',      `created_at < NOW() - INTERVAL '60 days'`],
  ['notifications',      `status IN ('sent','delivered','failed','cancelled') AND created_at < NOW() - INTERVAL '30 days'`],
  ['audit_log',          `created_at < NOW() - INTERVAL '90 days'`],
  ['auth_attempts',      `created_at < NOW() - INTERVAL '30 days'`],
  ['webhook_deliveries', `created_at < NOW() - INTERVAL '30 days'`],
  ['sms_codes',          `created_at < NOW() - INTERVAL '24 hours'`],
];

async function runRetention(pool = getPool()) {
  const out = [];
  for (const [table, cond] of RULES) {
    try {
      if (!(await pool.query(`SELECT to_regclass($1) r`, ['public.' + table])).rows[0].r) continue;
      const r = await pool.query(`DELETE FROM ${table} WHERE ${cond}`);
      out.push({ table, deleted: r.rowCount });
      if (r.rowCount) console.log(`[retention] ${table}: удалено ${r.rowCount}`);
    } catch (e) {
      out.push({ table, error: e.message });
      console.error(`[retention] ${table}:`, e.message);
    }
  }
  return out;
}

let _timer = null;
function startRetentionCron() {
  if (_timer) return;
  // первый прогон через 5 мин после старта, далее раз в 24ч
  setTimeout(() => runRetention().catch(() => {}), 5 * 60 * 1000);
  _timer = setInterval(() => runRetention().catch(() => {}), 24 * 3600 * 1000);
  console.log('[retention] cron активен (раз в 24ч)');
}

module.exports = { runRetention, startRetentionCron, RULES };
