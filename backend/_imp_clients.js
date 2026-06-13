require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false} });
const TENANT='00000000-0000-0000-0000-000000000001';

function normPhone(p){
  if(!p) return null;
  let d=String(p).split(/[,;]/)[0].replace(/\D/g,'');
  if(d.length===10 && d.startsWith('0')) d='38'+d;
  if(d.length===9) d='380'+d;
  if(d.length===12 && d.startsWith('380')) return d;
  if(d.length===11 && d.startsWith('80')) return '3'+d;
  return d.length>=10?d:null;
}
const junkName=n=>{const s=(n||'').trim().toLowerCase();return !s||s===','||s==='.'||s.startsWith('binotel')||/^[.,\s]+$/.test(s);};

(async()=>{
  const rows=JSON.parse(fs.readFileSync('/tmp/crm_import/MyBusiness-export-MyClients-47787-2026.05.24-09_09.Xlsx.json','utf8')).slice(1);
  // [Имя,Телефон,Email,Метки,Сумма продаж,Кол-во визитов,Дата посл,Дата перв,ЧС]
  const existing=(await pool.query(`SELECT id,phone,name,total_spent FROM clients`)).rows;
  const byPhone=new Map(); existing.forEach(c=>{const p=normPhone(c.phone); if(p)byPhone.set(p,c);});

  let inserted=0,updated=0,skipped=0;
  for(const r of rows){
    const name=(r[0]||'').trim();
    const phone=normPhone(r[1]);
    const spent=parseFloat(String(r[4]||'0').replace(/[, ]/g,''))||0;
    const visits=parseInt(r[5])||0;
    const email=(r[2]||'').trim()||null;
    const tags=(r[3]||'').split(',').map(t=>t.trim()).filter(Boolean);
    const lastVisit=r[6] && r[6]!=='-'?r[6]:null;
    // тільки реальні клієнти: є візити або продажі (інакше — телефонна книга)
    if((visits<=0 && spent<=0) || junkName(name) || !phone){ skipped++; continue; }
    const hit=byPhone.get(phone);
    if(hit){
      await pool.query(
        `UPDATE clients SET total_spent=GREATEST(COALESCE(total_spent,0),$1),
           name=CASE WHEN (name IS NULL OR name='' OR name ILIKE '%тест%' OR name ILIKE '%гість%') THEN $2 ELSE name END,
           email=COALESCE(email,$3),
           tags=CASE WHEN array_length(tags,1) IS NULL THEN $4::text[] ELSE tags END
         WHERE id=$5`,
        [spent, name||null, email, tags.length?tags:null, hit.id]);
      updated++;
    } else {
      const ins=await pool.query(
        `INSERT INTO clients (tenant_id,phone,name,email,total_spent,tags,source)
         VALUES ($1,$2,$3,$4,$5,$6,'beautypro') RETURNING id`,
        [TENANT,phone,name,email,spent,tags.length?tags:null]);
      byPhone.set(phone,{id:ins.rows[0].id});
      inserted++;
    }
  }
  const tot=(await pool.query(`SELECT count(*) c,count(*) FILTER(WHERE total_spent>0) paying FROM clients`)).rows[0];
  console.log(JSON.stringify({inserted,updated,skipped_junk:skipped,clients_now:tot.c,paying:tot.paying}));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
