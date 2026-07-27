require('dotenv/config');
const { runAs } = require('./lib/tenant');
const { getPool } = require('./db-pg');
const pool = getPool();
const MAIN = '00000000-0000-0000-0000-000000000001';

async function main() {
  await runAs(MAIN, async () => {
    // Distribution of beautypro appts by month
    const dist = await pool.query(`SELECT to_char(starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM') ym,
       COUNT(*) n, COUNT(*) FILTER (WHERE status IN ('done','completed')) done
       FROM appointments WHERE COALESCE(source,'') IN ('beautypro','bukon_import')
       GROUP BY 1 ORDER BY 1 DESC LIMIT 8`);
    console.log('=== beautypro appts by month ===');
    dist.rows.forEach(r=>console.log(' ',r.ym,'total',r.n,'done',r.done));

    // What ref_types exist in cash_operations type=in? Where does bp revenue actually sit?
    const rt = await pool.query(`SELECT COALESCE(ref_type,'(null)') rt, category, COUNT(*) n, COALESCE(SUM(amount),0) s
       FROM cash_operations WHERE type='in' GROUP BY 1,2 ORDER BY s DESC LIMIT 15`);
    console.log('\n=== cash_operations type=in by ref_type/category ===');
    rt.rows.forEach(r=>console.log(' ',r.rt,'/',r.category,'n',r.n,'sum',r.s));

    // July: how much ZP commission is accrued for beautypro appts specifically (part of the 260281)?
    const bpZp = await pool.query(`
      WITH matlines AS (SELECT asv.appointment_id aid, 0 mat FROM appointment_services asv GROUP BY 1),
        da AS (SELECT a.master_id, GREATEST(0,COALESCE(a.real_amount,a.price,0)) rev_labor, a.source
          FROM appointments a
          WHERE a.starts_at BETWEEN '2026-07-01 00:00:00 Europe/Kyiv' AND '2026-07-31 23:59:59 Europe/Kyiv'
            AND a.starts_at <= NOW()
            AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
            AND COALESCE(a.source,'') <> 'migrate')
      SELECT da.source, COUNT(*) n,
             COALESCE(SUM(da.rev_labor*COALESCE(ps.percent,0)/100),0) zp
        FROM da LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE
       WHERE ps.scheme_type IN ('percent','hybrid')
       GROUP BY da.source ORDER BY zp DESC`);
    console.log('\n=== July accrued % commission by appointment source (in the 260281 total) ===');
    bpZp.rows.forEach(r=>console.log(' ',r.source||'(null)','appts',r.n,'ZP≈',Math.round(r.zp)));
  });
  await pool.end();
}
main().catch(e => { console.error('ERR', e.stack); process.exit(1); });
