require('dotenv').config();const{getPool}=require('./db-pg');
const k=process.env.RENDER_API_KEY, SRV="srv-d8ipvrbtqb8s73bepvfg", owner="tea-d8htl07lk1mc73fhjiig";
(async()=>{const p=getPool();
const base=await p.query("SELECT COALESCE(MAX(updated_at),NOW()) m FROM booking_sessions");
const baseC=await p.query("SELECT COALESCE(MAX(created_at),NOW()) m FROM clients");
const t0=base.rows[0].m, c0=baseC.rows[0].m;
console.log('база: слежу за новыми сессиями/клиентами/записями и ошибками бота (4 мин)...');
for(let i=0;i<16;i++){
  await new Promise(s=>setTimeout(s,15000));
  const ns=await p.query("SELECT tg_user_id,state,updated_at FROM booking_sessions WHERE updated_at>$1 ORDER BY updated_at DESC LIMIT 5",[t0]);
  const nc=await p.query("SELECT telegram_id,name,created_at FROM clients WHERE created_at>$1 ORDER BY created_at DESC LIMIT 5",[c0]);
  const na=await p.query("SELECT id,status,source,created_at FROM appointments WHERE created_at>$1 AND source LIKE '%bot%' ORDER BY id DESC LIMIT 5",[c0]);
  if(ns.rows.length||nc.rows.length||na.rows.length){
    console.log(`\n🔔 [${new Date().toISOString().slice(11,19)}] АКТИВНОСТЬ:`);
    ns.rows.forEach(r=>console.log('  сессия uid='+r.tg_user_id+' state='+r.state));
    nc.rows.forEach(r=>console.log('  НОВЫЙ клиент tg='+r.telegram_id+' name='+r.name));
    na.rows.forEach(r=>console.log('  ЗАПИСЬ id='+r.id+' '+r.status));
  }
  // ошибки отправки
  const l=await fetch(`https://api.render.com/v1/logs?ownerId=${owner}&resource=${SRV}&limit=10&direction=backward&text=${encodeURIComponent("booking/tg")}`,{headers:{Authorization:"Bearer "+k}}).then(r=>r.json()).catch(()=>({logs:[]}));
  const errs=(l.logs||[]).filter(e=>new Date(e.timestamp)>t0 && !/chat not found.*999/.test(e.message));
  errs.filter(e=>new Date(e.timestamp)>new Date(Date.now()-16000)).forEach(e=>console.log('  ⚠️ '+(e.message||'').slice(0,110)));
}
console.log('\nнаблюдение завершено (4 мин).');
process.exit(0);})().catch(e=>{console.log('watch err',e.message);process.exit(0)});
