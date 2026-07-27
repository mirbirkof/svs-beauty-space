require('dotenv/config');
const { runAs } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const { liveFinance } = require('./lib/live-finance');
const pool = getPool();

const EMPTY = 'cc2e3b42-f8f7-49bf-a1dc-769df3d96196'; // demo-fitness, no cash_ops
const from = '2026-07-01 00:00:00 Europe/Kyiv';
const to   = '2026-07-31 23:59:59 Europe/Kyiv';

async function main() {
  await runAs(EMPTY, async () => {
    const fin = await liveFinance(pool, from, to);
    console.log('=== liveFinance on EMPTY tenant (demo-fitness) ===');
    console.log(JSON.stringify(fin, null, 1));
    console.log('avg_check isNaN?', Number.isNaN(fin.avg_check), ' margin isNaN?', Number.isNaN(fin.profit.margin_pct));
  });

  // Boundary test: an op at exactly 2026-07-31 23:59:59.5 Kyiv or 2026-08-01 00:00:00
  // live-finance uses BETWEEN $1 AND $2 (inclusive of to='...23:59:59'), pnl uses < end ('...next day 00:00').
  // Row at 23:59:59.400 -> included by BETWEEN (<=23:59:59? No! 23:59:59.4 > 23:59:59). Check.
  await runAs('00000000-0000-0000-0000-000000000001', async () => {
    const r = await pool.query(`SELECT
      (TIMESTAMPTZ '2026-07-31 23:59:59.400 Europe/Kyiv' BETWEEN TIMESTAMPTZ '2026-07-31 23:59:59 Europe/Kyiv' AND TIMESTAMPTZ '2026-07-31 23:59:59 Europe/Kyiv') live_between,
      (TIMESTAMPTZ '2026-07-31 23:59:59.400 Europe/Kyiv' < TIMESTAMPTZ '2026-08-01 00:00:00 Europe/Kyiv') pnl_halfopen`);
    console.log('\n=== Boundary: op at 23:59:59.400 on last day ===');
    console.log('included by live-finance BETWEEN 00:00..23:59:59:', r.rows[0].live_between);
    console.log('included by pnl half-open < next-day-00:00     :', r.rows[0].pnl_halfopen);
    // Any real cash_operations in that gap historically?
    const gap = await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM cash_operations
      WHERE type='in' AND EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Europe/Kyiv'))=23
        AND EXTRACT(MINUTE FROM (created_at AT TIME ZONE 'Europe/Kyiv'))=59
        AND EXTRACT(SECOND FROM (created_at AT TIME ZONE 'Europe/Kyiv'))>0`);
    console.log('historical cash_ops in the 23:59:59.x gap (all time):', gap.rows[0].n, 'sum', gap.rows[0].s);
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
