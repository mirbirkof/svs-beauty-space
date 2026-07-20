import fs from 'fs';
import { createRequire } from 'module'; const require2 = createRequire('/tmp/xlsx-tool/x.js');
const { PDFParse } = require2('pdf-parse');
import pg from '/home/client/workspace/svs-beauty-space/backend/node_modules/pg/lib/index.js';
const { Client } = pg;
const APPLY = process.argv.includes('--apply');
const norm = s => String(s==null?'':s).toLowerCase().replace(/[^a-zа-яїієґ ]/gi,'').trim();
const COLOR = /фарбув|тонув|освітл|airtouch|air touch|babyl|мелірув|балаяж|шатуш|розтяжк|деколор|блонд|complex|colorplex|змив волосс/i;
const GRAM = /eterna|extremo|socolor|sync|окисник|оксид|фарб|краск|invidia|тонер|порош|бонд|освітл|окислюв|барвник|degreaser|complex|колорплекс|colorplex|аміак|оксид|пудра/i;
// 1) по дням: клиенты на окрашивании (из реестра визитов cash_report.pdf)
const vt = (await new PDFParse({ data: fs.readFileSync('/home/client/workspace/.media/bukon-export/cash_report.pdf') }).getText()).text;
const colorByDay = {}; // 'DD.MM.YY' -> Set(client)
for (const ch of vt.split(/(?=\d{2}\.\d{2}\.\d{2} \d{2}:\d{2})/)) {
  const md = ch.match(/^(\d{2})\.(\d{2})\.(\d{2}) /); if (!md) continue;
  const day = `20${md[3]}-${md[2]}-${md[1]}`;
  const mcl = ch.match(/([^\t\n]+?)\s+(Пришел|Скасовано|Не пришел|Подтвердил|Записан)/); if (!mcl) continue;
  if (COLOR.test(ch)) { (colorByDay[day]=colorByDay[day]||new Set()).add(norm(mcl[1])); }
}
// 2) продажи sales2 -> розница если НЕ (краска-пограмово И клиент на окрашивании в тот день)
const t = (await new PDFParse({ data: fs.readFileSync('/home/client/workspace/.media/bukon-export/sales2.pdf') }).getText()).text;
const re = /(\d{2})\.(\d{2})\.(\d{4})\s+\d{2}:\d{2}\s+([^\t]+?)\s+(.+?)\s+Продажа товаров\s+([^\t]+?)\s+([\d.,]+)\s+([^\n\t]+)/g;
const retail = []; let m;
while ((m = re.exec(t))) {
  const day=`${m[3]}-${m[2]}-${m[1]}`, name=m[5].trim().replace(/\s+/g,' '), amt=parseFloat(m[7].replace(/,/g,'')), client=norm(m[8]), author=m[4].trim(), method=/готів|налич/i.test(m[6])?'cash':'card';
  const onColor = (colorByDay[day]||new Set()).has(client);
  const HOME = /проти випадіння|puroxine|medavita|dr.?sorbie|додому/i;
  const isMaterial = onColor && !HOME.test(name);
  if (!isMaterial) retail.push({ day, author, name, amt, method, client: m[8].trim() });
}
console.log('розничных продаж (не материал):', retail.length, 'на', retail.reduce((s,o)=>s+o.amt,0).toFixed(0));
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} }); await c.connect();
if (APPLY) {
  const tn = (await c.query("SELECT tenant_id FROM cash_operations WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1")).rows[0].tenant_id;
  const masters = {}; (await c.query("SELECT id,lower(split_part(btrim(name),' ',1)) f FROM masters")).rows.forEach(r=>{ if(!masters[r.f]) masters[r.f]=r.id; });
  await c.query('BEGIN');
  await c.query(`DELETE FROM cash_operations WHERE type='in' AND category='sale_product' AND ref_type IS NULL AND description LIKE 'Продаж:%'`);
  for (const o of retail) { const mid=masters[o.author.toLowerCase()]||null;
    await c.query(`INSERT INTO cash_operations (type,category,amount,method,ref_type,master_id,created_at,tenant_id,description)
      VALUES ('in','sale_product',$1,$2,NULL,$3,($4||' 12:00 Europe/Kyiv')::timestamptz,$5,$6)`,
      [o.amt,o.method,mid,o.day,tn,'Продаж: '+o.name+' — '+o.client]); }
  await c.query('COMMIT');
  console.log('>>> заведено:', retail.length);
}
const svc = (await c.query(`SELECT (created_at AT TIME ZONE 'Europe/Kyiv')::date::text d, SUM(amount)::float s FROM cash_operations WHERE type='in' AND category='sale_service' GROUP BY 1`)).rows;
const sv={}; svc.forEach(x=>sv[x.d]=+x.s);
const rd={}; retail.forEach(o=>rd[o.day]=(rd[o.day]||0)+o.amt);
for (const d of ['2026-07-18','2026-07-20','2026-04-15','2026-02-28','2026-06-14']) console.log(`  ${d}: визиты ${(sv[d]||0).toFixed(0)} + розница ${(rd[d]||0).toFixed(0)} = ${((sv[d]||0)+(rd[d]||0)).toFixed(1)}`);
console.log('эталоны: 18=36466.5, 20=17653');
await c.end();
