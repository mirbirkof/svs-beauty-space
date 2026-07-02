#!/usr/bin/env node
/**
 * Render failover watcher.
 * Monitors PRIMARY (acc1) and BACKUP (acc2) CRM services.
 * - Picks the healthy backend (primary preferred).
 * - Auto-resumes a suspended service via Render API when possible.
 * - Keeps the idle backend warm (free tier spins down after 15 min).
 * - Writes the active URL to state + publishes it for the redirect page.
 * - Telegram-alerts the owner whenever the active backend changes.
 *
 * Stateless per run — schedule via cron every ~2 min.
 * Reads secrets from environment (.env files loaded below).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- load .env files (own-engine + workspace) without extra deps ----
for (const p of [
  path.join(process.env.HOME, 'workspace/own-engine/.env'),
  path.join(process.env.HOME, 'workspace/.env'),
  path.join(__dirname, '../backend/.env'),
]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}

const PRIMARY = {
  name: 'primary',
  key: process.env.RENDER_API_KEY,
  sid: 'srv-d8ipvrbtqb8s73bepvfg',
  url: 'https://svs-shop-api.onrender.com',
};
const BACKUP = {
  name: 'backup',
  key: process.env.RENDER_API_KEY_2,
  sid: 'srv-d900roho3t8c73bqd7cg',
  url: 'https://svs-shop-api-backup.onrender.com',
};

const STATE_FILE = '/tmp/render-failover-state.json';
const LOG_FILE = '/tmp/render-failover.log';
const PUBLISH_FILE = path.join(__dirname, 'active-backend.json'); // served as stable pointer

const TG_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_NOTIFY_TOKEN;
const TG_CHAT = process.env.ADMIN_ID;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  console.log(line);
}

function req(method, url, headers = {}, body = null, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...headers },
    };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function health(svc) {
  const r = await req('GET', svc.url + '/health');
  return r.status === 200;
}

async function suspendState(svc) {
  if (!svc.key) return 'unknown';
  const r = await req('GET', `https://api.render.com/v1/services/${svc.sid}`, {
    Authorization: `Bearer ${svc.key}`,
  });
  if (r.status !== 200) return 'unknown';
  try { return JSON.parse(r.body).suspended || 'not_suspended'; } catch { return 'unknown'; }
}

async function resume(svc) {
  if (!svc.key) return false;
  const r = await req('POST', `https://api.render.com/v1/services/${svc.sid}/resume`, {
    Authorization: `Bearer ${svc.key}`,
  });
  log(`resume(${svc.name}) -> HTTP ${r.status} ${r.body.slice(0, 120)}`);
  return r.status === 200 || r.status === 202;
}

// Перезапуск зависшего інстансу (живий процес, але HTTP не відповідає — 000/timeout).
// resume лікує лише suspended; для «висить» потрібен саме restart.
async function restart(svc) {
  if (!svc.key) return false;
  const r = await req('POST', `https://api.render.com/v1/services/${svc.sid}/restart`, {
    Authorization: `Bearer ${svc.key}`,
  });
  log(`restart(${svc.name}) -> HTTP ${r.status}`);
  return r.status === 200 || r.status === 202;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await req('POST', `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    {}, { chat_id: TG_CHAT, parse_mode: 'HTML', text, disable_web_page_preview: true });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
}
function publish(active) {
  try {
    fs.writeFileSync(PUBLISH_FILE, JSON.stringify({
      active_url: active.url, active: active.name, updated_at: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}
}

async function checkOnce() {
  // ЭКОНОМИЯ ЛИМИТОВ (02.07): резерв НЕ пингуем каждый тик. Пинг будит free-tier сервис,
  // он не засыпает и жжёт часы круглосуточно → к концу месяца выгорают ОБА аккаунта.
  // Резерв проверяем ТОЛЬКО когда основной упал (тогда он и должен проснуться).
  const pHealthy = await health(PRIMARY);
  const bHealthy = pHealthy ? false : await health(BACKUP);

  // choose active: primary preferred, else backup
  let active = pHealthy ? PRIMARY : bHealthy ? BACKUP : null;

  const prev = readState();
  const now = new Date().toISOString();
  const RESTART_THROTTLE_MS = 10 * 60 * 1000; // не частіше разу на 10 хв
  const FAIL_THRESHOLD = 3;                    // 3 невдалі тіки поспіль (~6 хв)

  // Авто-відновлення сервісу: suspended → resume; «висить» (живий, але HTTP мовчить) → restart.
  async function recover(svc, healthy) {
    const fkey = 'fail_' + svc.name, rkey = 'lastRestart_' + svc.name;
    if (healthy) { prev[fkey] = 0; return; }
    const st = await suspendState(svc);
    if (st === 'suspended') {
      // Skip resume if previously blocked (400 — Render won't allow it for 6h)
      const blockedKey = 'resumeBlocked_' + svc.name;
      const blockedUntil = prev[blockedKey] ? new Date(prev[blockedKey]).getTime() : 0;
      if (Date.now() < blockedUntil) {
        log(`${svc.name}: resume skipped (blocked until ${new Date(blockedUntil).toISOString()})`);
        return;
      }
      const ok = await resume(svc);
      if (ok) {
        log(`${svc.name}: resume requested (was suspended)`);
        delete prev[blockedKey];
      } else {
        // 400 = Render won't allow resume (force-suspended). Back off 6 hours.
        prev[blockedKey] = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
        log(`${svc.name}: resume blocked by Render (400) — skipping for 6h`);
        writeState(prev);
      }
      return;
    }
    // not_suspended але нездоровий → завис. Рахуємо поспіль і рестартимо з тротлінгом.
    prev[fkey] = (prev[fkey] || 0) + 1;
    const sinceRestart = Date.now() - (prev[rkey] ? new Date(prev[rkey]).getTime() : 0);
    if (prev[fkey] >= FAIL_THRESHOLD && sinceRestart > RESTART_THROTTLE_MS) {
      log(`${svc.name}: завис (${prev[fkey]} тіків поспіль) → restart`);
      const ok = await restart(svc);
      prev[rkey] = now; prev[fkey] = 0;
      if (ok) await tg(`🔧 <b>CRM (${svc.name})</b> завис і не відповідав — перезапустив автоматично. За хвилину має піднятися.`).catch(()=>{});
    }
  }

  // recovery actions. Резерв «восстанавливаем» (resume/restart) ТОЛЬКО когда основной упал —
  // иначе разбудим спящий резерв и снова начнём жечь его лимиты (экономия 02.07).
  await recover(PRIMARY, pHealthy);
  if (!pHealthy) await recover(BACKUP, bHealthy);

  if (!active) {
    log('BOTH DOWN — primary & backup unhealthy');
    if (prev.bothDownNotified !== true) {
      await tg('🔴 <b>CRM: оба сервера недоступны</b>\nИ основной, и резервный не отвечают. Пытаюсь поднять автоматически.');
    }
    writeState({ ...prev, active: null, bothDownNotified: true, checkedAt: now });
    return;
  }

  publish(active);

  if (prev.active !== active.name) {
    const emoji = active.name === 'primary' ? '🟢' : '🟡';
    const label = active.name === 'primary' ? 'основной (аккаунт 1)' : 'РЕЗЕРВНЫЙ (аккаунт 2)';
    await tg(
      `${emoji} <b>CRM переключилась на ${label}</b>\n` +
      `Рабочий адрес: <code>${active.url}/admin/</code>\n` +
      (active.name === 'backup'
        ? 'Основной аккаунт упёрся в лимит/suspend. Резерв принял нагрузку, данные те же (общая база Neon).'
        : 'Основной сервер снова в строю — вернул нагрузку на него.')
    );
    log(`SWITCH: ${prev.active || 'none'} -> ${active.name}`);
  }

  writeState({
    ...prev,
    active: active.name,
    activeUrl: active.url,
    primaryHealthy: pHealthy,
    backupHealthy: bHealthy,
    bothDownNotified: false,
    checkedAt: now,
    since: prev.active === active.name ? prev.since || now : now,
  });
  log(`OK active=${active.name} primaryHealthy=${pHealthy} backupHealthy=${bHealthy}`);
}

const INTERVAL_MS = 120000; // 2 min
if (process.argv.includes('--daemon')) {
  log('daemon started (interval 120s)');
  const tick = () => checkOnce().catch((e) => log('check error: ' + e.message));
  tick();
  setInterval(tick, INTERVAL_MS);
} else {
  checkOnce().catch((e) => log('check error: ' + e.message));
}
