import pg from '/home/client/workspace/svs-beauty-space/backend/node_modules/pg/lib/index.js';
const { Client } = pg;
const APPLY = process.argv.includes('--apply');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} }); await c.connect();
// материалы-строки в кассе (краска уже в цене визита по Букону) = задвоение
const pre = (await c.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0)::float s FROM cash_operations WHERE type='in' AND category='sale_product' AND ref_type='appointment'`)).rows[0];
console.log('материалы-строки в кассе (задвоение):', pre.n, 'на', (+pre.s).toFixed(0));
if (APPLY) {
  await c.query('BEGIN');
  await c.query(`DROP TABLE IF EXISTS cash_matlines_backup_20260720`);
  await c.query(`CREATE TABLE cash_matlines_backup_20260720 AS SELECT * FROM cash_operations WHERE type='in' AND category='sale_product' AND ref_type='appointment'`);
  const del = await c.query(`DELETE FROM cash_operations WHERE type='in' AND category='sale_product' AND ref_type='appointment' RETURNING id`);
  await c.query('COMMIT');
  console.log('>>> убрано материалов-строк из кассы:', del.rows.length);
}
// касса 18.07 после
const d18 = (await c.query(`SELECT category, COALESCE(SUM(amount),0)::float s FROM cash_operations WHERE type='in' AND (created_at AT TIME ZONE 'Europe/Kyiv')::date='2026-07-18' GROUP BY category`)).rows;
let tot=0; console.log('Касса 18.07 после:'); d18.forEach(x=>{tot+=x.s; console.log(`  ${x.category}: ${(+x.s).toFixed(0)}`);});
console.log('  ИТОГО:', tot.toFixed(0), '| эталон Букон 36466.5');
await c.end();
