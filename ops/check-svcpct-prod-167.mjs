// Живий прод :3011, 1280x900: форма схеми ЗП → блок «Окремий % на послуги» (нотатка #167). Без збереження — реальні схеми не чіпає.
import { createRequire } from 'node:module';
const BK='/home/client/workspace/svs-beauty-space/backend/';
const require=createRequire(BK);
require(BK+'node_modules/dotenv').config({path:BK+'.env'});
const { chromium } = require('/home/client/workspace/svs-beauty-space/node_modules/playwright');
const T=process.env.ADMIN_TOKEN, B='http://127.0.0.1:3011', out=[], errs=[];
const ck=(n,ok,x='')=>out.push(`${ok?'✓':'✗'} ${n}${x?' — '+x:''}`);
const b=await chromium.launch({args:['--no-sandbox']});
try{
 const p=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
 p.on('pageerror',e=>errs.push(e.message));
 const apiReq=[]; p.on('response',r=>{ if(/payouts\/rules|payroll\/schemes/.test(r.url())) apiReq.push(r.status()+' '+r.url().replace(B,'')); });
 await p.goto(B+'/admin/',{waitUntil:'domcontentloaded'});
 await p.evaluate(t=>localStorage.setItem('svs_admin_token',t),T);
 await p.goto(B+'/admin/',{waitUntil:'networkidle'});
 ck('viewport width=1280',(await p.evaluate(()=>document.querySelector('meta[name=viewport]').content))==='width=1280');
 await p.evaluate(()=>go('payroll')); await p.evaluate(()=>payrollTab('schemes'));
 await p.waitForSelector('#payrollList table',{timeout:20000});
 ck('таблиця схем',(await p.$$('#payrollList tbody tr')).length>0, (await p.$$('#payrollList tbody tr')).length+' рядків');
 await p.click('#pypane-schemes button:has-text("Нова / змінити схему")');
 await p.waitForSelector('#sfMaster');
 const opts=await p.$$eval('#sfMaster option',o=>o.filter(x=>x.value).map(x=>[x.value,x.textContent]));
 const first=opts[0]; await p.selectOption('#sfMaster',first[0]);
 ck('майстер обраний, % схеми підставився',true,first[1]+' / '+await p.inputValue('#sfPercent')+'% / '+await p.inputValue('#sfType'));
 ck('блок «Окремий % на послуги»',await p.isVisible('#sfSvcSec >> text=Окремий % на послуги'));
 const nsvc=await p.$$eval('#sfSvcList option',o=>o.length); ck('послуги салону в пошуку',nsvc>0,nsvc+' шт');
 await p.click('#sfAddRuleBtn'); await p.click('#sfAddRuleBtn');
 const labels=await p.$$eval('#sfSvcList option',o=>o.slice(0,2).map(x=>x.value));
 const rows=await p.$$('#sfRules .sf-rule');
 await rows[rows.length-2].$eval('.sf-rule-svc',(e,v)=>e.value=v,labels[0]); await (await rows[rows.length-2].$('.sf-rule-pct')).fill('50');
 await rows[rows.length-1].$eval('.sf-rule-svc',(e,v)=>e.value=v,labels[1]); await (await rows[rows.length-1].$('.sf-rule-pct')).fill('30');
 ck('два рядки з різним %',(await p.$$('#sfRules .sf-rule')).length>=2, labels.join(' | '));
 await p.screenshot({path:'/home/client/workspace/svs-beauty-space/reports/svcpct-0210/4-prod-form-167.png'});
 await p.selectOption('#sfType','fixed'); ck('фікс → підказка',await p.isVisible('.sf-fixed-hint'));
 // закрити БЕЗ збереження
 await p.keyboard.press('Escape');
 ck('API',apiReq.every(s=>s.startsWith('200')),apiReq.join(', '));
 ck('JS-помилок 0',errs.length===0,errs.join(' | '));
}catch(e){out.push('✗ ВПАЛО '+e.message)} finally{await b.close();console.log(out.join('\n'));}
