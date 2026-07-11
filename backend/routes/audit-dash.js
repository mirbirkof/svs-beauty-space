/* Живой дашборд аудита CRM — публичная страница на проде (Render).
   Локальная машина шлёт снимок POST /push (токен), страница GET / показывает и авто-обновляет.
   Данные в памяти процесса (эфемерно, для мониторинга — не персист). */
'use strict';
const express = require('express');
const router = express.Router();

let SNAP = { ts: null, note: 'ждём первый снимок с рабочей машины…' };
const TOKEN = process.env.AUDIT_DASH_TOKEN || 'jarvis-audit-2026';

router.post('/push', express.json({ limit: '2mb' }), (req, res) => {
  if ((req.headers['x-audit-token'] || '') !== TOKEN) return res.status(403).json({ ok: false });
  SNAP = req.body || {};
  SNAP.ts = new Date().toISOString();
  res.json({ ok: true });
});

router.get('/data', (req, res) => res.json(SNAP));

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRM — живой аудит</title>
<style>
 body{margin:0;background:#0b0f1a;color:#e6edf3;font:14px/1.5 -apple-system,system-ui,sans-serif;padding:14px}
 h1{font-size:17px;margin:0 0 2px}.muted{color:#8b98a9;font-size:12px}
 .bar{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:12px;margin:10px 0}
 .live{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;animation:p 1.2s infinite}
 @keyframes p{50%{opacity:.3}}
 .spec{background:#0f1524;border:1px solid #1f2937;border-radius:10px;padding:9px 11px;margin-bottom:7px;border-left:3px solid #64748b}
 .spec.ok{border-left-color:#22c55e}.spec.fail{border-left-color:#ef4444}
 .sh{display:flex;justify-content:space-between}.t{color:#64748b;font-size:11px}
 .sm{color:#9fb0c3;font-size:12px}
 .find{font-size:12px;margin-top:4px;padding:4px 6px;border-radius:6px;background:#1a1030}
 .find.blocker{background:#3b1015;color:#fca5a5}.find.major{background:#3a2a10;color:#fcd34d}
 pre{white-space:pre-wrap;font-size:12px;background:#0f1524;padding:10px;border-radius:8px;border:1px solid #1f2937}
</style></head><body>
<h1>🔬 Живой аудит CRM</h1><div class="muted" id="sub">загрузка…</div>
<div id="app"></div>
<script>
async function tick(){
 try{
  const r=await fetch('/api/audit-dash/data',{cache:'no-store'}); const d=await r.json();
  const running=d.running;
  const age=d.ts?Math.round((Date.now()-new Date(d.ts).getTime())/1000):null;
  document.getElementById('sub').textContent='обновлено '+(age==null?'—':age+'с назад')+' · машина '+(age!=null&&age<25?'на связи':'молчит')+(d.round?' · раунд '+d.round:'')+(d.deadline?' · цикл до '+d.deadline:'');
  let h='<div class="bar"><span class="live" style="background:'+(running?'#22c55e':'#f59e0b')+'"></span><b>'+(running?'КОМИССИЯ РАБОТАЕТ':'раунд завершён')+'</b> <span class="muted">— '+(d.done||0)+'/'+(d.total||12)+' специалистов · подтверждено находок: '+(d.confirmed_count||0)+'</span></div>';
  (d.specs||[]).forEach(function(s){
    h+='<div class="spec '+(s.ok?'ok':(s.dead?'fail':''))+'"><div class="sh"><b>'+s.key+'</b><span class="t">'+(s.time||'')+'</span></div>';
    h+='<div class="sm">'+(s.ok?('готовность '+s.pct+'% · находок: '+s.findings):(s.dead?'сорвался (перезапустится)':'читает код…'))+'</div>';
    (s.top||[]).forEach(function(f){ h+='<div class="find '+f.severity+'">['+f.severity+(f.is_regression?'·РЕГРЕСС':'')+'] '+f.title+'</div>'; });
    h+='</div>';
  });
  if(d.verdict){ h+='<h1 style="margin-top:14px">Вердикт раунда</h1><pre>'+d.verdict+'</pre>'; }
  if(d.log){ h+='<div class="muted" style="margin-top:10px">лог: '+d.log+'</div>'; }
  document.getElementById('app').innerHTML=h;
 }catch(e){ document.getElementById('sub').textContent='нет данных: '+e.message; }
}
tick(); setInterval(tick,4000);
</script></body></html>`);
});

module.exports = router;
