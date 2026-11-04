process.chdir('/home/client/workspace/svs-beauty-space/backend');require('dotenv').config();
const {Client}=require('pg');const crypto=require('crypto');const {chromium}=require('/home/client/workspace/node_modules/playwright');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const o=(await c.query("select u.id,u.display_name,u.tenant_id,r.code role from users u join roles r on r.id=u.role_id where r.code='owner' and u.is_active order by u.id limit 1")).rows[0];
const T='qa-team-'+crypto.randomBytes(12).toString('hex');
await c.query('begin');await c.query('set transaction read write');await c.query("INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,'qa-team-0411',NOW()+INTERVAL '10 minutes',$3)",[o.id,crypto.createHash('sha256').update(T).digest('hex'),o.tenant_id]);await c.query('commit');
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:900}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
try{await p.goto('http://127.0.0.1:3011/admin/',{waitUntil:'domcontentloaded'});
await p.evaluate(({t,u})=>{localStorage.setItem('svs_admin_token',t);localStorage.setItem('svs_user',JSON.stringify(u))},{t:T,u:{id:o.id,display_name:o.display_name,role:'owner'}});
await p.goto('http://127.0.0.1:3011/admin/crm-extra.html#users',{waitUntil:'domcontentloaded',timeout:20000});await p.waitForTimeout(5000);
console.log('url',p.url(),'frames',p.frames().map(f=>f.url().slice(-40)).join(' | '));
await p.evaluate(()=>openEmbed('/admin/crm-extra.html#users','badge Команда'));await p.waitForTimeout(6000);
let fr=p.frames().find(f=>/crm-extra/.test(f.url()));console.log('frame',fr&&fr.url());
await fr.evaluate(()=>{const b=document.querySelector('nav.tabs button[data-tab="users"]');if(b)b.click()});await p.waitForTimeout(4000);
const txt=await fr.evaluate(()=>[...document.querySelectorAll('tr')].map(r=>r.innerText.replace(/\s+/g,' ')).filter(x=>/Анжела/.test(x)).join('\n'));console.log(txt||'(рядків не знайдено)');
await fr.evaluate(()=>{const r=[...document.querySelectorAll('tr')].find(x=>x.innerText.includes('Настя'));if(r)r.scrollIntoView({block:'center'})});
const rows=await fr.$$('tr');for(const r of rows){const t=await r.innerText();if(/^\s*А\s*Ася|^\s*Е\s*Евеліна/.test(t)||/Ася|Евеліна/.test(t.split('\n').slice(0,2).join(' '))){await r.screenshot({path:'/tmp/igh/row-'+(t.includes('Ася')?'asya':'evel')+'.png'})}}console.log('pageerrors',errs.length,errs.slice(0,2));}
finally{await b.close();await c.query('begin');await c.query('set transaction read write');await c.query("delete from user_tokens where label='qa-team-0411'");await c.query('commit');await c.end();}})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
