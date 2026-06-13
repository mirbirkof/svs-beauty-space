require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false} });
const TENANT='00000000-0000-0000-0000-000000000001';
const norm=s=>(s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');
const BATCH='bp_export_2026-05-24';

const STATUS={'Пришел':'done','Записан':'booked','Подтвердил':'confirmed','Скасовано':'cancelled','Отказался':'cancelled','Не пришел':'noshow'};
const PAY={'Карта':'card','Наличные':'cash'};

function parseDate(s){ // '20.06.26 11:00' -> '2026-06-20 11:00:00'
  const m=String(s).trim().match(/(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  if(!m) return null;
  return `20${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:00`;
}
function durMin(s){ // '3 ч. 30 мин.'
  if(!s) return 60; let t=0;
  const h=String(s).match(/(\d+)\s*ч/); const mi=String(s).match(/(\d+)\s*мин/);
  if(h)t+=parseInt(h[1])*60; if(mi)t+=parseInt(mi[1]); return t||60;
}

(async()=>{
  // 1) BACKUP (не перезаписувати оригінал)
  if(!fs.existsSync('/tmp/crm_import/appointments_backup.json')){
    const all=(await pool.query(`SELECT * FROM appointments`)).rows;
    fs.writeFileSync('/tmp/crm_import/appointments_backup.json', JSON.stringify(all));
    console.log('backup appts:',all.length);
  } else console.log('backup exists, skip');

  // 2) Lookup maps
  const masters=(await pool.query(`SELECT id,name,specialty FROM masters`)).rows;
  const mByName=new Map();
  masters.forEach(m=>{
    mByName.set(norm(m.name),m);
    const t=norm(m.name).split(' '); if(t.length===2) mByName.set(t[1]+' '+t[0],m); // зворотній порядок
  });
  const ALIAS={'вера колорист':'вера','лера маникюр':'лера','світлана скібенко':'скібенко світлана'};
  async function resolveMaster(mname){
    let k=norm(mname);
    if(ALIAS[k]) k=ALIAS[k];
    if(mByName.has(k)) return mByName.get(k);
    const t=k.split(' '); if(t.length===2 && mByName.has(t[1]+' '+t[0])) return mByName.get(t[1]+' '+t[0]);
    if(t.length===1){ // один токен — шукаємо унікальний збіг по першому імені
      const cand=masters.filter(m=>norm(m.name).split(' ').includes(t[0]));
      if(cand.length===1) return cand[0];
    }
    // створюємо нового майстра
    const ins=await pool.query(`INSERT INTO masters (tenant_id,name,active) VALUES ($1,$2,true) RETURNING id,name,specialty`,[TENANT,mname]);
    const nm=ins.rows[0]; masters.push(nm); mByName.set(norm(nm.name),nm);
    return nm;
  }
  const services=(await pool.query(`SELECT id,name FROM services`)).rows;
  const sByName=new Map(); services.forEach(s=>{ if(!sByName.has(norm(s.name))) sByName.set(norm(s.name),s.id); });
  const clients=(await pool.query(`SELECT id,name FROM clients WHERE name IS NOT NULL`)).rows;
  const cByName=new Map(); clients.forEach(c=>{ const k=norm(c.name); if(!cByName.has(k)) cByName.set(k,c.id); });

  // 3) DELETE past appointments (will replace from export). Keep future (>= today).
  const del=await pool.query(`DELETE FROM appointments WHERE starts_at < (now() AT TIME ZONE 'Europe/Kiev')::date`);
  console.log('deleted past appts:',del.rowCount);

  // 4) Import export visits with date < today
  const rows=JSON.parse(fs.readFileSync('/tmp/crm_import/visits_export_24052026090921.xlsx.json','utf8')).slice(1);
  let ins=0, skipFuture=0, noMaster=0;
  const specialtyUpd=new Map();
  for(const r of rows){
    const dts=parseDate(r[0]); if(!dts) continue;
    const dateOnly=dts.slice(0,10);
    const today=new Date().toISOString().slice(0,10);
    if(dateOnly>=today){ skipFuture++; continue; } // майбутні беремо з живої БД
    // master
    const empRaw=(r[1]||'').trim();
    const mname=empRaw.replace(/\s*\(.*$/,'').trim();
    const spec=(empRaw.match(/\(([^)]+)\)/)||[])[1]||null;
    const m=mname?await resolveMaster(mname):null;
    if(!m){ noMaster++; }
    if(m && spec && !m.specialty && !specialtyUpd.has(m.id)) specialtyUpd.set(m.id,spec);
    const servText=(r[2]||'').trim()||null;
    const firstServ=servText?servText.split(',')[0].trim():null;
    const sid=firstServ?sByName.get(norm(firstServ))||null:null;
    const cname=(r[3]||'').trim()||null;
    const cid=cname?cByName.get(norm(cname))||null:null;
    const status=STATUS[(r[5]||'').trim()]||'done';
    const dur=durMin(r[6]);
    const price=parseFloat(String(r[7]||'0').replace(/[, ]/g,''))||0;
    const pay=PAY[(r[8]||'').trim()]||null;
    const cashback=parseFloat(String(r[9]||'0').replace(/[, ]/g,''))||null;
    await pool.query(
      `INSERT INTO appointments
        (tenant_id,client_id,master_id,service_id,starts_at,ends_at,status,price,
         payment_method,cashback,client_name,services_text,source,import_batch,bp_state)
       VALUES ($1,$2,$3,$4,
         ($5::timestamp AT TIME ZONE 'Europe/Kiev'),
         ($5::timestamp AT TIME ZONE 'Europe/Kiev') + ($6 || ' minutes')::interval,
         $7,$8,$9,$10,$11,$12,'beautypro',$13,'imported')`,
      [TENANT,cid,m?m.id:null,sid,dts,dur,status,price,pay,cashback,cname,servText,BATCH]);
    ins++;
  }
  // update specialties
  for(const [id,sp] of specialtyUpd) await pool.query(`UPDATE masters SET specialty=$1 WHERE id=$2`,[sp,id]);

  const stat=(await pool.query(`SELECT status,count(*) FROM appointments GROUP BY status ORDER BY 2 DESC`)).rows;
  const paymix=(await pool.query(`SELECT payment_method,count(*),sum(price)::int rev FROM appointments WHERE status='done' GROUP BY payment_method`)).rows;
  console.log(JSON.stringify({inserted:ins,skipFuture,noMaster,specialtiesSet:specialtyUpd.size}));
  console.log('STATUS',JSON.stringify(stat));
  console.log('PAYMIX(done)',JSON.stringify(paymix));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
