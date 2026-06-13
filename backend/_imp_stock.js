require('dotenv').config();
const fs=require('fs');
const { Pool }=require('pg');
const url=process.env.DATABASE_URL;
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
const TENANT='00000000-0000-0000-0000-000000000001';
const num=s=>{ if(s==null) return null; const m=String(s).replace(/\s/g,'').replace(',','').match(/-?\d+(\.\d+)?/); return m?parseFloat(m[0]):null; };

(async()=>{
  const rows=JSON.parse(fs.readFileSync('/tmp/crm_import/product_reminders_export_24052026091141.xlsx.json','utf8')).slice(1);
  // [Артикул,Товар,Категория,Остаток,Себест,СумСоб,Цена,СумЦена]
  await pool.query(`DELETE FROM salon_stock WHERE tenant_id=$1`,[TENANT]); // ідемпотентний реімпорт
  let ins=0;
  for(const r of rows){
    const name=(r[1]||'').trim(); if(!name) continue;
    const catRaw=(r[2]||'').trim();
    const kind=/товар на продаж/i.test(catRaw)?'retail':'consumable';
    const category=catRaw.replace(/\s*\((витратні матеріали|товар на продаж)\)/i,'').trim()||catRaw;
    const qtyM=String(r[3]||'').match(/([\d.,]+)\s*([^\s/]+)/);
    const qty=qtyM?num(qtyM[1]):0;
    const unit=qtyM?qtyM[2]:null;
    const cost=num(r[4]);
    const totalCost=num(r[5]);
    const price=num(r[6]);
    const totalPrice=num(r[7]);
    await pool.query(
      `INSERT INTO salon_stock (tenant_id,sku,name,category,kind,unit,qty,cost_per_unit,price_per_unit,total_cost,total_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [TENANT,(r[0]||null),name,category,kind,unit,qty||0,cost,price,totalCost,totalPrice]);
    ins++;
  }
  const sum=(await pool.query(`SELECT kind,count(*) items,sum(total_cost)::int cost,sum(total_price)::int price FROM salon_stock GROUP BY kind`)).rows;
  console.log(JSON.stringify({inserted:ins}));
  console.log('BY KIND',JSON.stringify(sum));
  await pool.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
