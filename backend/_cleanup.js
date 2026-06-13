require('dotenv').config();
const { Pool } = require('pg');
const url=process.env.DATABASE_URL;
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
const isTest=`(c.name IS NULL OR c.name ~* '(^|\\s)(тест|test|гість|аудит|jarvis|босс|binotel|pass e2e|e2e)(\\s|$)')`;
const deps=['loyalty_ledger','sessions','waitlist','online_bookings','reviews','favorites'];
(async()=>{
  const a=await pool.query(`DELETE FROM appointments WHERE import_batch IS NULL AND (client_name ~* '(e2e|verify|^pass |\\bpass e2e|\\btest\\b|тест)')`);
  const ids=(await pool.query(`SELECT c.id FROM clients c WHERE ${isTest}`)).rows.map(r=>r.id);
  let report={del_test_appts:a.rowCount};
  if(ids.length){
    const ords=(await pool.query(`SELECT id FROM orders WHERE client_id=ANY($1)`,[ids])).rows.map(r=>r.id);
    if(ords.length){
      await pool.query(`DELETE FROM payments WHERE order_id=ANY($1)`,[ords]);
      await pool.query(`DELETE FROM order_items WHERE order_id=ANY($1)`,[ords]).catch(()=>{});
      await pool.query(`DELETE FROM orders WHERE id=ANY($1)`,[ords]);
    }
    for(const t of deps){ await pool.query(`DELETE FROM ${t} WHERE client_id=ANY($1)`,[ids]).catch(e=>console.log('skip',t,e.message)); }
    await pool.query(`UPDATE masters SET client_id=NULL WHERE client_id=ANY($1)`,[ids]);
  }
  const c=await pool.query(`DELETE FROM clients c WHERE ${isTest} AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id=c.id)`);
  const left=(await pool.query(`SELECT count(*) FILTER(WHERE name ~* 'тест|test') t, count(*) total, count(*) FILTER(WHERE total_spent>0) paying, sum(total_spent)::int spent FROM clients`)).rows[0];
  console.log(JSON.stringify({...report,del_test_clients:c.rowCount,test_left:left.t,clients_total:left.total,paying:left.paying,sum_spent:left.spent}));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
