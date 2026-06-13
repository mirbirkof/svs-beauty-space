require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_APP;
const pool = new Pool({ connectionString: url, ssl: url.includes('neon.tech')||url.includes('supabase')?{rejectUnauthorized:false}:false });
const TENANT = '00000000-0000-0000-0000-000000000001';
const norm = s => (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');

(async()=>{
  const rows = JSON.parse(fs.readFileSync('/tmp/crm_import/Послуги SVS beauty space.xlsx.json','utf8')).slice(1);
  // [Назва категорії, Рекл.кат, Назва послуги, Рекл.послуги, Вартість, Тривалість, Опис]
  const exp = rows.filter(r=>r[2]).map(r=>({
    cat: (r[0]||'').trim(), name:(r[2]||'').trim(),
    price: parseFloat(String(r[4]||'0').replace(',','.'))||null,
    dur: parseInt(r[5])||null, descr:(r[6]||'').trim()||null
  }));
  const existing = (await pool.query(`SELECT id,name,category,price,duration_min FROM services`)).rows;
  const byName = new Map(); existing.forEach(s=>byName.set(norm(s.name), s));

  let updated=0, inserted=0;
  for (const e of exp){
    const hit = byName.get(norm(e.name));
    if (hit){
      await pool.query(
        `UPDATE services SET category=$1, description=COALESCE($2,description),
           price=CASE WHEN price IS NULL OR price=0 THEN COALESCE($3,price) ELSE price END,
           duration_min=COALESCE(duration_min,$4) WHERE id=$5`,
        [e.cat, e.descr, e.price, e.dur, hit.id]);
      updated++;
    } else {
      await pool.query(
        `INSERT INTO services (tenant_id,name,category,price,duration_min,description,active)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [TENANT, e.name, e.cat, e.price||0, e.dur||60, e.descr]);
      inserted++;
    }
  }
  // Для послуг чия категорія досі GUID і яких немає в експорті — пробуємо лишити, але логуємо
  const guidLeft = (await pool.query(`SELECT count(*) c FROM services WHERE category ~ '^[0-9a-f]{8}-'`)).rows[0].c;
  console.log(JSON.stringify({export_rows:exp.length, updated, inserted, services_with_guid_category_left:guidLeft}));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
