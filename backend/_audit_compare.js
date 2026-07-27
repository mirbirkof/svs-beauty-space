require('dotenv/config');
const { runAs, DEFAULT_TENANT_ID } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const { liveFinance } = require('./lib/live-finance');

const pool = getPool();
const from = '2026-07-01 00:00:00 Europe/Kyiv';
const to   = '2026-07-31 23:59:59 Europe/Kyiv';
// pnl uses half-open [start,end): start=from, end=next day 00:00
const pstart = '2026-07-01 00:00:00 Europe/Kyiv';
const pend   = '2026-08-01 00:00:00 Europe/Kyiv';

async function main() {
  await runAs(DEFAULT_TENANT_ID, async () => {
    const fin = await liveFinance(pool, from, to);
    console.log('=== liveFinance (July, main tenant) ===');
    console.log('revenue.total   =', fin.revenue.total, '(svc', fin.revenue.services, '+ prod', fin.revenue.products, ')');
    console.log('expenses.total  =', fin.expenses.total, '(mat', fin.expenses.materials, '+ comm', fin.expenses.commission, ')');
    console.log('profit.net      =', fin.profit.net, ' margin', fin.profit.margin_pct);
    console.log('avg_check       =', fin.avg_check, ' visits', fin.visits_count, ' tx', fin.tx_count);

    // --- COGS reason divergence: live-finance excludes consumption/writeoff, pnl includes ---
    const cogsLive = await pool.query(`SELECT COALESCE(SUM(-sm.delta * COALESCE(pv.wholesale,0)),0)::numeric s, COUNT(*) n
       FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id
      WHERE sm.reason IN ('consumption','writeoff') AND sm.created_at >= $1 AND sm.created_at < $2
        AND COALESCE(sm.notes,'') !~* '^(e2e|тест|test)'`, [pstart, pend]);
    console.log('\n=== COGS reasons ONLY in pnl (consumption/writeoff), excluded by live-finance ===');
    console.log('rows:', cogsLive.rows[0].n, ' approx-cost:', cogsLive.rows[0].s);

    // --- salPiece double count check: payroll_records percent_part overlapping July ---
    const salP = await pool.query(`SELECT COALESCE(SUM(percent_part),0)::numeric s, COUNT(*) n
       FROM payroll_records WHERE status IN ('approved','paid') AND period_start < $2 AND period_end >= $1`, [pstart, pend]);
    console.log('\n=== pnl salPiece (payroll_records percent_part) added ON TOP of accruedCommission ===');
    console.log('rows:', salP.rows[0].n, ' sum:', salP.rows[0].s, ' (accruedCommission from live =', fin.expenses.commission, ')');

    // --- pnl extra revenue lines not in live-finance ---
    const subs = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='in' AND category='sale_subscription' AND created_at>=$1 AND created_at<$2`,[pstart,pend]);
    const otherIn = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='in' AND category NOT IN ('sale_service','sale_product','sale_certificate','sale_subscription') AND created_at>=$1 AND created_at<$2`,[pstart,pend]);
    const refunds = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='out' AND category='refund' AND created_at>=$1 AND created_at<$2`,[pstart,pend]);
    console.log('\n=== pnl revenue lines NOT in live-finance ===');
    console.log('subscriptions:', subs.rows[0].s, ' other_income:', otherIn.rows[0].s, ' refunds(neg):', refunds.rows[0].s);
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
