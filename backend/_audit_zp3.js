require('dotenv/config');
const { runAs } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const pool = getPool();
const MAIN = '00000000-0000-0000-0000-000000000001';

async function main() {
  await runAs(MAIN, async () => {
    // ZP accrues on: status done/completed OR (confirmed AND real_synced_at IS NOT NULL).
    // But revenue = cash_operations only. Does an appt accrue ZP without any cash? (asymmetry)
    // Reproduce EXACT live-finance commission eligibility, check paid vs unpaid.
    const q = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE paid) paid_n,
        COUNT(*) FILTER (WHERE NOT paid) unpaid_n,
        COALESCE(SUM(rev) FILTER (WHERE NOT paid),0) unpaid_rev
      FROM (
        SELECT a.id, GREATEST(0,COALESCE(a.real_amount,a.price,0)) rev,
          (a.pay_settled_at IS NOT NULL
           OR EXISTS(SELECT 1 FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id)) paid
        FROM appointments a
        WHERE a.starts_at BETWEEN '2026-07-01 00:00:00 Europe/Kyiv' AND '2026-07-31 23:59:59 Europe/Kyiv'
          AND a.starts_at <= NOW()
          AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
          AND COALESCE(a.source,'') <> 'migrate'
      ) t`);
    console.log('=== July: ZP-eligible appts, paid vs unpaid (revenue is only from cash) ===');
    console.log('paid appts:', q.rows[0].paid_n, ' | UNPAID appts accruing ZP:', q.rows[0].unpaid_n,
                ' | their nominal revenue not in cash:', q.rows[0].unpaid_rev);
    console.log('=> ZP accrues on unpaid appts but their money is NOT in revenue => commission > matched revenue');

    // Confirm: liveFinance commission includes these unpaid ones (no paidExpr filter in commission query)
    // vs revenue services from cash only
    const rev = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM cash_operations
       WHERE type='in' AND category='sale_service'
         AND created_at BETWEEN '2026-07-01 00:00:00 Europe/Kyiv' AND '2026-07-31 23:59:59 Europe/Kyiv'`);
    console.log('\nJuly revenue.services (cash) =', rev.rows[0].s);
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
