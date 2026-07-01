#!/usr/bin/env node
/* Веб-панель управления QA-платформой.
   Отдаёт визуальный дашборд + JSON API поверх реестра багов.
   Доступ защищён секретным путём /p/<QA_PANEL_TOKEN>. Порт QA_PANEL_PORT (деф. 3020).
   Запуск: node server.js  (держится демоном qa-daemon.sh вместе с loop). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const reg = require('./lib/registry');

const PORT = Number(process.env.QA_PANEL_PORT || 3020);
const TOKEN = process.env.QA_PANEL_TOKEN || 'svsqa';
const dataFile = (n) => path.join(cfg.dataDir, n);
const readJSON = (n, d) => { try { return JSON.parse(fs.readFileSync(dataFile(n), 'utf8')); } catch (_) { return d; } };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function apiState() {
  const status = readJSON('status.json', {});
  const all = reg.allBugs();
  const norm = (b) => ({ id: b.id, sig: b.signature, sev: b.severity, module: b.module, role: b.role, title: b.title,
    scenario: b.scenario, expected: b.expected, actual: b.actual, cause: b.cause, fix: b.fix, steps: b.steps || [],
    status: b.status, needsManual: b.needsManual, manualReason: b.manualReason, seenCount: b.seenCount,
    firstSeen: b.firstSeen, lastSeen: b.lastSeen, fixRequested: !!b.fixRequested });
  return {
    status,
    paused: fs.existsSync(dataFile('pause.flag')),
    open: all.filter((b) => ['open', 'reopened'].includes(b.status)).map(norm),
    manual: all.filter((b) => b.status === 'manual').map(norm),
    fixQueue: all.filter((b) => b.fixRequested && !['closed', 'ignored'].includes(b.status)).map(norm),
    closed: all.filter((b) => b.status === 'closed').map(norm),
    ignored: all.filter((b) => b.status === 'ignored').map(norm),
  };
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const parts = u.pathname.split('/').filter(Boolean); // ['p','<token>', ...]
    if (parts[0] !== 'p' || parts[1] !== TOKEN) return send(res, 403, { error: 'forbidden' }, 'text/plain');
    const rest = parts.slice(2);

    // GET /p/<t>            → HTML
    if (req.method === 'GET' && rest.length === 0) return send(res, 200, HTML(), 'text/html');
    // GET /p/<t>/api/state  → данные
    if (req.method === 'GET' && rest[0] === 'api' && rest[1] === 'state') return send(res, 200, apiState());
    // POST /p/<t>/api/bug/<sig>/(ignore|fix)
    if (req.method === 'POST' && rest[0] === 'api' && rest[1] === 'bug' && rest[3]) {
      const sig = rest[2], act = rest[3];
      if (act === 'ignore') { reg.ignoreBug(sig, 'panel'); return send(res, 200, { ok: true }); }
      if (act === 'fix') { reg.requestFix(sig, 'panel'); return send(res, 200, { ok: true }); }
      return send(res, 400, { error: 'bad-action' });
    }
    // POST /p/<t>/api/(pause|resume)
    if (req.method === 'POST' && rest[0] === 'api' && (rest[1] === 'pause' || rest[1] === 'resume')) {
      const pf = dataFile('pause.flag');
      if (rest[1] === 'pause') fs.writeFileSync(pf, 'paused via panel');
      else { try { fs.unlinkSync(pf); } catch (_) {} }
      return send(res, 200, { ok: true, paused: rest[1] === 'pause' });
    }
    return send(res, 404, { error: 'not-found' }, 'text/plain');
  } catch (e) { send(res, 500, { error: e.message }); }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[qa-panel] http://0.0.0.0:${PORT}/p/${TOKEN}`));

function HTML() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA-панель · SVS CRM</title>
<style>
:root{--bg:#0f1115;--card:#191c23;--card2:#20242d;--tx:#e8eaed;--mut:#9aa0aa;--line:#2a2f3a;--acc:#6c8cff;
--crit:#ff5470;--high:#ff9f43;--med:#ffd93d;--low:#8a92a0;--ok:#33d69f;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:16px;max-width:820px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:16px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;flex:1;min-width:120px}
.kpi b{font-size:22px;display:block}.kpi span{color:var(--mut);font-size:12px}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tab{background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:8px 14px;cursor:pointer;font-size:13px}
.tab.on{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.card .h{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.sev{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;white-space:nowrap}
.sev.critical{background:var(--crit);color:#fff}.sev.high{background:var(--high);color:#111}.sev.medium{background:var(--med);color:#111}.sev.low{background:var(--low);color:#fff}
.mod{color:var(--acc);font-weight:600;font-size:13px}.ttl{margin:4px 0;font-weight:600}
.meta{color:var(--mut);font-size:12.5px}
.det{margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:13px;display:none}
.det.show{display:block}.det div{margin:3px 0}.det .lbl{color:var(--mut)}
.acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.btn{border:none;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer}
.btn.fix{background:var(--ok);color:#062}.btn.ign{background:var(--card2);color:var(--mut);border:1px solid var(--line)}
.btn.more{background:transparent;color:var(--acc);border:1px solid var(--line)}
.pausebtn{background:var(--high);color:#111}.pausebtn.paused{background:var(--ok);color:#052}
.empty{color:var(--mut);text-align:center;padding:24px}
.tag{font-size:11px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 4px;border-bottom:1px solid var(--line)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
</style></head><body>
<h1>🧪 QA-панель <span id="pz"></span></h1>
<div class="sub" id="sub">загрузка…</div>
<div class="bar" id="kpi"></div>
<div style="margin-bottom:14px"><button class="btn pausebtn" id="pauseBtn" onclick="togglePause()">⏸ Пауза</button>
<button class="btn more" onclick="load()">🔄 Обновить</button></div>
<div class="tabs" id="tabs"></div>
<div id="list"></div>
<script>
const T=location.pathname.replace(/\\/$/,'');let S=null,tab='open';
const SEVN={critical:0,high:1,medium:2,low:3};
async function load(){const r=await fetch(T+'/api/state');S=await r.json();render();}
function togglePause(){const a=S&&S.paused?'resume':'pause';fetch(T+'/api/'+a,{method:'POST'}).then(()=>load());}
function act(sig,a){fetch(T+'/api/bug/'+sig+'/'+a,{method:'POST'}).then(()=>load());}
function tgl(id){document.getElementById(id).classList.toggle('show');}
function esc(s){return(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}
function render(){
 const st=S.status||{},b=st.bugs||{};
 document.getElementById('pz').innerHTML=S.paused?'<span class="tag" style="color:#ff9f43">на паузе</span>':'';
 document.getElementById('sub').textContent='Цикл '+(st.cycle||'?')+' · режим '+(st.mode||'?')+' · '+(st.modules||0)+' модулей, '+(st.checks||0)+' проверок';
 const pb=document.getElementById('pauseBtn');pb.textContent=S.paused?'▶️ Запустить':'⏸ Пауза';pb.classList.toggle('paused',!!S.paused);
 document.getElementById('kpi').innerHTML=
  kpi(S.open.length,'открыто','var(--crit)')+kpi(S.fixQueue.length,'в работе','var(--ok)')+
  kpi(S.manual.length,'ручных','var(--high)')+kpi(S.closed.length,'закрыто','var(--mut)');
 const tabs=[['open','Открытые',S.open.length],['fixQueue','В работе',S.fixQueue.length],['manual','Ручные',S.manual.length],['ignored','Игнор',S.ignored.length],['closed','Закрытые',S.closed.length],['agents','Агенты',(st.agents||[]).length]];
 document.getElementById('tabs').innerHTML=tabs.map(t=>'<div class="tab'+(tab===t[0]?' on':'')+'" onclick="tab=\\''+t[0]+'\\';render()">'+t[1]+' '+t[2]+'</div>').join('');
 const L=document.getElementById('list');
 if(tab==='agents'){L.innerHTML=agents(st.agents||[]);return;}
 let arr=S[tab]||[];arr=arr.slice().sort((x,y)=>SEVN[x.sev]-SEVN[y.sev]);
 if(!arr.length){L.innerHTML='<div class="empty">Пусто — тут ничего нет 👌</div>';return;}
 L.innerHTML=arr.map((x,i)=>card(x,i,tab)).join('');
}
function kpi(v,l,c){return '<div class="kpi"><b style="color:'+c+'">'+v+'</b><span>'+l+'</span></div>';}
function card(x,i,t){
 const id='d'+t+i;
 const manual=t==='manual';
 return '<div class="card"><div class="h"><div><span class="mod">'+esc(x.module)+'</span> <span class="tag">'+esc(x.role)+'</span>'+
  '<div class="ttl">'+esc(x.title)+'</div>'+
  (x.actual?'<div class="meta">'+esc(x.actual)+'</div>':'')+'</div>'+
  '<span class="sev '+x.sev+'">'+x.sev+'</span></div>'+
  '<div class="det" id="'+id+'">'+
   (x.scenario?'<div><span class="lbl">Сценарий:</span> '+esc(x.scenario)+'</div>':'')+
   (x.expected?'<div><span class="lbl">Ожидалось:</span> '+esc(x.expected)+'</div>':'')+
   (x.actual?'<div><span class="lbl">Получили:</span> '+esc(x.actual)+'</div>':'')+
   (x.cause?'<div><span class="lbl">Причина:</span> '+esc(x.cause)+'</div>':'')+
   (manual&&x.manualReason?'<div><span class="lbl">Почему вручную:</span> '+esc(x.manualReason)+'</div>':'')+
   '<div class="lbl">Замечен '+(x.seenCount||1)+'× · с '+(x.firstSeen||'').slice(0,10)+'</div></div>'+
  '<div class="acts">'+
   '<button class="btn more" onclick="tgl(\\''+id+'\\')">Детали</button>'+
   (t==='open'||t==='manual'?'<button class="btn fix" onclick="act(\\''+x.sig+'\\',\\'fix\\')">🔧 '+(x.fixRequested?'В работе ✓':'Исправить')+'</button>':'')+
   (t!=='ignored'&&t!=='closed'?'<button class="btn ign" onclick="act(\\''+x.sig+'\\',\\'ignore\\')">🙈 Игнорировать</button>':'')+
  '</div></div>';
}
function agents(a){if(!a.length)return '<div class="empty">нет данных</div>';
 const ic={ready:'#33d69f',partial:'#ffd93d',gated:'#8a92a0',meta:'#6c8cff'};
 return '<div class="card"><table>'+a.map(x=>'<tr><td><span class="dot" style="background:'+(ic[x.status]||'#888')+'"></span>'+esc(x.role)+'</td>'+
  '<td class="meta">'+esc(x.covers||'')+'</td>'+
  '<td style="text-align:right;white-space:nowrap">циклов '+(x.stats&&x.stats.cycles||0)+'<br>багов '+(x.stats&&x.stats.bugs||0)+'</td></tr>').join('')+'</table></div>';
}
load();setInterval(load,15000);
</script></body></html>`;
}
