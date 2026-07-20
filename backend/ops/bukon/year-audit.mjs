import fs from 'fs';
import { createRequire } from 'module'; const require2 = createRequire('/tmp/xlsx-tool/x.js');
const { PDFParse } = require2('pdf-parse');
import XLSX from '/tmp/xlsx-tool/node_modules/xlsx/xlsx.js';
import imp from '/home/client/workspace/svs-beauty-space/backend/lib/visits-import.js';
import pg from '/home/client/workspace/svs-beauty-space/backend/node_modules/pg/lib/index.js';
const { Client } = pg;
const norm = s => String(s==null?'':s).toLowerCase().replace(/[^a-zа-яїієґ ]/gi,'').trim();
const COLOR = /фарбув|тонув|освітл|airtouch|air touch|babyl|мелірув|балаяж|шатуш|розтяжк|деколор|блонд|complex|colorplex|змив волосс/i;
const HOME = /проти випадіння|puroxine|medavita|dr.?sorbie|додому/i;
// Букон визиты(услуги) по дням
const wb = XLSX.readFile('/home/client/workspace/.media/bukon-export/visits_export_20072026.xlsx');
const { rows: vr } = imp.parseRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:null }));
const bukSvc = {};
for (const r of vr) if (r.starts_iso && r.status==='done' && (r.price||0)>0) { const d=r.starts_iso.slice(0,10); bukSvc[d]=(bukSvc[d]||0)+r.price; }
// клиенты на окрашивании по дням (реестр визитов)
const vt = (await new PDFParse({ data: fs.readFileSync('/home/client/workspace/.media/bukon-export/cash_report.pdf') }).getText()).text;
const colorByDay = {};
for (const ch of vt.split(/(?=\d{2}\.\d{2}\.\d{2} \d{2}:\d{2})/)) { const md=ch.match(/^(\d{2})\.(\d{2})\.(\d{2}) /); if(!md)continue; const day=`20${md[3]}-${md[2]}-${md[1]}`; const mcl=ch.match(/([^\t\n]+?)\s+(Пришел|Скасовано|Не пришел|Подтвердил|Записан)/); if(!mcl)continue; if(COLOR.test(ch))(colorByDay[day]=colorByDay[day]||new Set()).add(norm(mcl[1])); }
// розница по правилу по дням
const t = (await new PDFParse({ data: fs.readFileSync('/home/client/workspace/.media/bukon-export/sales2.pdf') }).getText()).text;
const re = /(\d{2})\.(\d{2})\.(\d{4})\s+\d{2}:\d{2}\s+([^\t]+?)\s+(.+?)\s+Продажа товаров\s+([^\t]+?)\s+([\d.,]+)\s+([^\n\t]+)/g;
const bukRetail = {}; let m;
while ((m = re.exec(t))) { const day=`${m[3]}-${m[2]}-${m[1]}`, name=m[5].trim(), amt=parseFloat(m[7].replace(/,/g,'')), client=norm(m[8]);
  const onColor=(colorByDay[day]||new Set()).has(client); if (!(onColor && !HOME.test(name))) bukRetail[day]=(bukRetail[day]||0)+amt; }
// наша БД касса за день
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} }); await c.connect();
const our = (await c.query(`SELECT (created_at AT TIME ZONE 'Europe/Kyiv')::date::text d,
   SUM(amount) FILTER (WHERE category='sale_service')::float svc, SUM(amount) FILTER (WHERE category='sale_product')::float prod,
   SUM(amount) FILTER (WHERE category NOT IN ('sale_service','sale_product'))::float other
   FROM cash_operations WHERE type='in' GROUP BY 1`)).rows;
const od = {}; our.forEach(x=>od[x.d]={svc:+x.svc||0,prod:+x.prod||0,other:+x.other||0});
// сверка всех дней
const days = [...new Set([...Object.keys(bukSvc), ...Object.keys(od)])].filter(d=>d<='2026-07-19').sort();
let ok=0, bad=0; const badList=[]; let ybS=0,ybR=0,yoS=0,yoR=0;
for (const d of days) {
  const eb = (bukSvc[d]||0) + (bukRetail[d]||0);
  const o = od[d]||{svc:0,prod:0,other:0}; const eo = o.svc+o.prod+o.other;
  ybS+=bukSvc[d]||0; ybR+=bukRetail[d]||0; yoS+=o.svc; yoR+=o.prod+o.other;
  if (Math.abs(eb-eo) <= 1) ok++; else { bad++; if(badList.length<20) badList.push(`${d}: наша ${eo.toFixed(0)} vs эталон ${eb.toFixed(0)} (${(eo-eb).toFixed(0)}) [усл ${o.svc.toFixed(0)}/${(bukSvc[d]||0).toFixed(0)} тов ${(o.prod+o.other).toFixed(0)}/${(bukRetail[d]||0).toFixed(0)}]`); }
}
console.log('ДНЕЙ проверено (до 19.07):', days.length, '| СОШЛОСЬ:', ok, '| расходится:', bad);
if (badList.length) { console.log('Расхождения:'); badList.forEach(x=>console.log('  '+x)); }
console.log(`\nГОД: услуги наша ${yoS.toFixed(0)} = Букон ${ybS.toFixed(0)} | товары наша ${yoR.toFixed(0)} = эталон-розница ${ybR.toFixed(0)}`);
console.log(`Общая касса (услуги+товары) наша: ${(yoS+yoR).toFixed(0)} | эталон: ${(ybS+ybR).toFixed(0)}`);
await c.end();
