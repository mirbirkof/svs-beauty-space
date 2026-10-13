require('dotenv').config({ path: process.argv[2] });
const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL||'') ? false : { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query("select column_name from information_schema.columns where table_name='masters' order by ordinal_position");
  console.log('masters cols:', cols.rows.map(r=>r.column_name).join(','));
  const ms = await pool.query("select id, name, surname, specialty, category, position_id, tenant_id, created_at, active from masters order by id desc limit 4");
  for (const m of ms.rows) {
    const s = await pool.query("select ms.source, count(*) n, min(ms.created_at) first, max(ms.created_at) last from master_services ms where ms.master_id=$1 group by 1", [m.id]);
    const cat = await pool.query("select coalesce(c.name, s.category, '?') cat, count(*) n from master_services ms join services s on s.id=ms.service_id left join service_categories c on c.id=s.category_id where ms.master_id=$1 group by 1 order by 2 desc limit 8", [m.id]).catch(e=>({rows:[{cat:'ERR '+e.message,n:0}]}));
    console.log(JSON.stringify(m), '\n  sources:', JSON.stringify(s.rows), '\n  cats:', JSON.stringify(cat.rows));
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
