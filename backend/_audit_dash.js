require('dotenv/config');
const { runAs } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const { liveFinance } = require('./lib/live-finance');
const pool = getPool();
const MAIN = '00000000-0000-0000-0000-000000000001';

async function main() {
  await runAs(MAIN, async () => {
    // Does dashboard's extra ref_type filter on sale_service drop rows?
    const r = await pool.query(`SELECT category, COUNT(*) n, COALESCE(SUM(amount),0) s
       FROM cash_operations WHERE type='in' AND category='sale_service' AND ref_type='order'
       GROUP BY category`);
    console.log('=== sale_service ops with ref_type=order (dashboard drops these, live-finance keeps) ===');
    console.log(r.rows);

    // Reproduce dashboard revenue_month exactly (current calendar month = July 2026)
    const dash = await pool.query(`
      WITH b AS (SELECT date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv') m0,
                        date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')+INTERVAL '1 month' m1),
        co AS (SELECT (created_at AT TIME ZONE 'Europe/Kyiv') k, amount FROM cash_operations
               WHERE type='in' AND category IN ('sale_service','sale_product') AND ref_type IS DISTINCT FROM 'order'),
        ord AS (SELECT (created_at AT TIME ZONE 'Europe/Kyiv') k, total FROM orders WHERE status='paid')
      SELECT (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.k>=b.m0 AND co.k<b.m1)
           + (SELECT COALESCE(SUM(total),0) FROM ord,b WHERE ord.k>=b.m0 AND ord.k<b.m1) rev`);
    console.log('\ndashboard revenue_month (July) =', dash.rows[0].rev);

    // liveFinance for exact same calendar month window used by financial.js (00:00..23:59:59 today)
    // Use current month full range up to now like financial 'month' preset
    const fin = await liveFinance(pool, '2026-07-01 00:00:00 Europe/Kyiv', '2026-07-31 23:59:59 Europe/Kyiv');
    console.log('liveFinance revenue.total (full July) =', fin.revenue.total);
    console.log('NOTE: dashboard uses [m0,m1) whole month incl future days; financial "month" preset uses [1st .. today 23:59:59].');
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
