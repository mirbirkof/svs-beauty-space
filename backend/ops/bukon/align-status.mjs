import XLSX from '/tmp/xlsx-tool/node_modules/xlsx/xlsx.js';
import pg from '/home/client/workspace/svs-beauty-space/backend/node_modules/pg/lib/index.js';
import imp from '/home/client/workspace/svs-beauty-space/backend/lib/visits-import.js';
const { Client } = pg;
const APPLY = process.argv.includes('--apply');
const wb = XLSX.readFile('/home/client/workspace/.media/bukon-export/visits_export_20072026.xlsx');
const { rows } = imp.parseRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:null }));
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} }); await c.connect();
const tn = (await c.query("SELECT tenant_id FROM cash_operations WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1")).rows[0].tenant_id;
const masters = {}; (await c.query('SELECT id,name FROM masters')).rows.forEach(r=>masters[imp.masterKey(r.name)]=r.id);

// Букон done по ключу день|master → список цен (сорт возр.)
const MAXBUK='2026-07-19';
const bukByDM = new Map();
for (const r of rows) {
  if (!r.starts_iso || r.status!=='done' || (r.price||0)<=0) continue;
  const mid = masters[imp.masterKey(r.master_raw)]; if (mid==null) continue;
  const day = r.starts_iso.slice(0,10); const k = day+'|'+mid;
  if (!bukByDM.has(k)) bukByDM.set(k, []); bukByDM.get(k).push({ price:r.price, iso:r.starts_iso, client:r.client_raw||'' });
}
// наши визиты в период Букона по ключу день|master (все статусы кроме уже cancelled фантомов)
const appt = (await c.query(`SELECT id, master_id, (starts_at AT TIME ZONE 'Europe/Kyiv')::date::text dd, starts_at, status, COALESCE(real_amount,price,0)::float p
  FROM appointments a WHERE (starts_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN '2025-12-01' AND '${MAXBUK}' AND COALESCE(bp_state,'')<>'phantom_dup'`)).rows;
const ourByDM = new Map();
appt.forEach(a=>{ const k=a.dd+'|'+a.master_id; if(!ourByDM.has(k))ourByDM.set(k,[]); ourByDM.get(k).push(a); });

let toDone=0, toCancel=0, toCreate=0;
const setDone=[], setCancel=[], create=[];
const allKeys = new Set([...bukByDM.keys(), ...ourByDM.keys()]);
for (const k of allKeys) {
  const buk = (bukByDM.get(k)||[]).slice().sort((a,b)=>a.price-b.price);
  const our = (ourByDM.get(k)||[]).slice().sort((a,b)=>a.p-b.p);
  // жадно: каждому Букон-визиту — один наш (по порядку), done + цена Букона
  let oi=0;
  for (const b of buk) {
    if (oi < our.length) { setDone.push({ id: our[oi].id, price: b.price }); oi++; toDone++; }
    else { const [d,mid]=k.split('|'); create.push({ day:d, mid:+mid, iso:b.iso, price:b.price, client:b.client }); toCreate++; }
  }
  // остаток наших (лишние сверх Букона) → cancelled
  for (; oi<our.length; oi++) { if (our[oi].status!=='cancelled') { setCancel.push(our[oi].id); toCancel++; } }
}
console.log('привести в done+цена Букон:', toDone, '| отменить лишних:', toCancel, '| создать недостающих:', toCreate);
if (APPLY) {
  await c.query('BEGIN');
  await c.query(`DROP TABLE IF EXISTS appt_status_backup_20260720`);
  await c.query(`CREATE TABLE appt_status_backup_20260720 AS SELECT id,status,real_amount,price FROM appointments WHERE (starts_at AT TIME ZONE 'Europe/Kyiv')::date <= '${MAXBUK}'`);
  for (const s of setDone) await c.query(`UPDATE appointments SET status='done', real_amount=$1 WHERE id=$2`, [s.price, s.id]);
  if (setCancel.length) await c.query(`UPDATE appointments SET status='cancelled', bp_state='not_in_bukon' WHERE id = ANY($1)`, [setCancel]);
  for (const cr of create) await c.query(`INSERT INTO appointments (master_id, starts_at, status, real_amount, price, source, tenant_id, client_name)
     VALUES ($1, ($2||' Europe/Kyiv')::timestamptz, 'done', $3, $3, 'bukon_import', $4, $5)`, [cr.mid, cr.iso+':00', cr.price, tn, cr.client.slice(0,40)]);
  // пересобрать кассу услуг из done-визитов
  await c.query(`DELETE FROM cash_operations WHERE type='in' AND category='sale_service' AND ref_type='appointment'`);
  const ins = await c.query(`INSERT INTO cash_operations (type,category,amount,method,master_id,ref_type,ref_id,created_at,tenant_id,description)
    SELECT 'in','sale_service',COALESCE(a.real_amount,a.price,0),COALESCE(a.payment_method,'card'),a.master_id,'appointment',a.id,a.starts_at,$1,'Оплата візиту'
      FROM appointments a WHERE a.status IN ('done','completed') AND COALESCE(a.real_amount,a.price,0)>0 RETURNING id`, [tn]);
  await c.query('COMMIT');
  console.log('>>> done:', setDone.length, '| cancel:', setCancel.length, '| create:', create.length, '| касса:', ins.rows.length);
}
await c.end();
