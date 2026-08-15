import {chromium} from 'playwright';
import {loginIntoPage} from '/home/client/workspace/svs-beauty-space/ops/qa-login.mjs';
const b=await chromium.launch({args:['--no-sandbox']});
try{
const p=await b.newPage({viewport:{width:1280,height:900}});
await loginIntoPage(p,'http://127.0.0.1:3037',process.env.QA_FUZZ_PHONE,process.env.QA_FUZZ_PASSWORD);
await p.goto('http://127.0.0.1:3037/admin/store.html?standalone=1',{waitUntil:'networkidle'});
await p.waitForTimeout(2500);
await p.click('.tab[data-pane="receipt"]'); await p.waitForTimeout(900);
await p.click('text=Новий товар (нема в базі)'); await p.waitForTimeout(600);
await p.fill('#rcNpName','QA Магазин Крем'); await p.fill('#rcNpVolume','200ml');
await p.fill('#rcNpPrice','399'); await p.fill('#rcNpWholesale','180');
await p.click('#rcNpBtn'); await p.waitForTimeout(2800);
const st=await p.evaluate(()=>({list:(document.getElementById('rcBody')||{}).innerText||'',err:(document.getElementById('rcNpErr')||{}).innerText||''}));
console.log('в приёмке:', st.list.slice(0,70).replace(/\n/g,' '));
console.log('ошибка формы:', st.err||'нет');
await p.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Новий товар/i.test(x.innerText));
  if(b){b.style.outline='4px solid #ff2d55';b.style.outlineOffset='3px';}});
await p.screenshot({path:'/tmp/store-newproduct.png'});
console.log('скрин снят');
}catch(e){console.log('СБОЙ:',e.message.slice(0,180));}
await b.close();
