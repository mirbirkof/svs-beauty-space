import { chromium } from '/home/client/workspace/node_modules/playwright/index.mjs';
import fs from 'fs';
const env = fs.readFileSync('/home/client/workspace/svs-beauty-space/backend/.env','utf8');
const tok = (env.match(/^ADMIN_TOKEN=(.*)$/m)||[])[1].trim().replace(/^["']|["']$/g,'');
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1280,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:3011/admin/login.html');
await p.evaluate(t=>localStorage.setItem('svs_admin_token',t), tok);
await p.goto('http://127.0.0.1:3011/admin/index.html#plan'); await p.waitForTimeout(3000);
await p.evaluate(()=>go('plan')); await p.waitForSelector('#planResult table',{timeout:20000});
const vp = await p.evaluate(()=>document.querySelector('meta[name=viewport]')?.content);
const read = async()=>p.evaluate(()=>({m:document.getElementById('planMonth').value,y:document.getElementById('planYear').value,
  note:document.getElementById('planCarryNote')?.innerText||null,
  rows:[...document.querySelectorAll('#planResult tbody tr')].map(tr=>tr.cells[0].innerText+'='+tr.querySelector('.pl-pershift').value)}));
console.log('viewport', vp);
console.log('CUR', JSON.stringify(await read()));
await p.screenshot({path:'/tmp/n162/oct.png'});
await p.evaluate(()=>planMonthNav(1)); await p.waitForTimeout(2500);
console.log('NEXT', JSON.stringify(await read()));
await p.screenshot({path:'/tmp/n162/nov.png'});
console.log('errors', errs);
await b.close();
