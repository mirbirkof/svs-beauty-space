require('dotenv/config');
const { runAs } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const pool = getPool();
const MAIN = '00000000-0000-0000-0000-000000000001';

async function main() {
  await runAs(MAIN, async () => {
    // 1) migrate appointments: how many, do any have cash in cash_operations?
    const mig = await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(real_amount,price,0)),0) amt
       FROM appointments WHERE COALESCE(source,'')='migrate'`);
    console.log('=== source=migrate appointments (excluded from ZP by payrollEligibleExpr) ===');
    console.log('count:', mig.rows[0].n, 'nominal amount:', mig.rows[0].amt);

    // Do migrate appts have any direct cash op ref_type=appointment? (asymmetry check)
    const migCash = await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(co.amount),0) s
       FROM cash_operations co JOIN appointments a ON a.id=co.ref_id AND co.ref_type='appointment'
       WHERE co.type='in' AND COALESCE(a.source,'')='migrate'`);
    console.log('migrate appts WITH direct cash op:', migCash.rows[0].n, 'sum:', migCash.rows[0].s,
                '=> if >0, revenue counts it but ZP does not (asymmetry)');

    // 2) legacy/bukon appts: ZP IS counted (source<>migrate). Verify they have cash (symmetry).
    const bp = await pool.query(`SELECT COALESCE(source,'(null)') src, COUNT(*) n
       FROM appointments WHERE COALESCE(source,'') IN ('legacy_import','bukon_import') GROUP BY 1`);
    console.log('\n=== legacy/bukon appts (ZP counted) ===');
    console.log(bp.rows);
    const bpCash = await pool.query(`SELECT COUNT(*) n FROM cash_operations WHERE type='in' AND ref_type='bp_sale'`);
    console.log('bp_sale cash ops (their revenue lives here):', bpCash.rows[0].n);

    // 3) The commission query in live-finance filters status + payrollEligible. But does it also
    //    accrue ZP for legacy appts that DON'T have matching cash (over-accrual)?
    //    Count legacy 'done' appts whose paidExpr is FALSE (ZP accrued but no cash = phantom expense).
    const phantom = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(COALESCE(a.real_amount,a.price,0)),0) amt
        FROM appointments a
       WHERE COALESCE(a.source,'') IN ('legacy_import','bukon_import')
         AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
         AND a.starts_at BETWEEN '2026-07-01 00:00:00 Europe/Kyiv' AND '2026-07-31 23:59:59 Europe/Kyiv'
         AND NOT (
           a.pay_settled_at IS NOT NULL
           OR EXISTS(SELECT 1 FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id)
           OR (a.legacy_client_ref IS NOT NULL AND a.master_id IS NOT NULL AND EXISTS(
                 SELECT 1 FROM cash_operations co WHERE co.type='in' AND co.ref_type='bp_sale' AND co.category='sale_service'
                   AND co.legacy_client_ref=a.legacy_client_ref AND co.master_id=a.master_id
                   AND (COALESCE(co.legacy_calendar_ref,co.created_at) AT TIME ZONE 'Europe/Kyiv')::date
                       = (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date)))`);
    console.log('\n=== July legacy DONE appts that get ZP but have NO matching cash (phantom ZP) ===');
    console.log('count:', phantom.rows[0].n, 'nominal:', phantom.rows[0].amt,
                '(live-finance commission does NOT apply paidExpr, only payrollEligibleExpr=source<>migrate)');
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
