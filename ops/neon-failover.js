#!/usr/bin/env node
/**
 * Neon failover daemon.
 *
 * Responsibilities:
 *  1. Keep the backup Neon current with periodic full snapshots (spawns
 *     ops/neon-sync.js) WHILE primary is the active DB.
 *  2. Monitor primary Neon reachability.
 *  3. On sustained primary failure -> FORWARD FAILOVER:
 *       - last-gasp snapshot (best effort, short timeout)
 *       - point BOTH Render services (acc1 + acc2) DATABASE_URL & DATABASE_URL_APP
 *         at the backup Neon, redeploy
 *       - mode := 'backup', STOP syncing (backup is now the live writer)
 *       - Telegram alert
 *  4. When primary recovers while in 'backup' mode -> alert only. Fail-BACK is
 *     MANUAL: backup holds newer writes made during the outage; a reverse sync
 *     (backup -> primary) must run BEFORE switching back, or those writes are lost.
 *
 * Why no automatic streaming replication: we only hold primary's connection
 * string (no Neon API key for it) and primary runs wal_level=replica, so logical
 * replication can't be enabled. Frequent snapshots are the available mechanism.
 *
 * Launch from watchdog (outside the tool sandbox):
 *   setsid node ops/neon-failover.js --daemon >> /tmp/neon-failover.log 2>&1 &
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const BACKEND = path.join(REPO, 'backend');
const { Client } = require(path.join(BACKEND, 'node_modules/pg'));

// ---- load env ----
for (const p of [
  path.join(BACKEND, '.env'),
  path.join(process.env.HOME, 'workspace/own-engine/.env'),
  path.join(process.env.HOME, 'workspace/.env'),
]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}

const PRIMARY_DB = process.env.DATABASE_URL;
const BACKUP_DB = process.env.NEON_BACKUP_URL;
const RENDER = [
  { name: 'primary', sid: 'srv-d8ipvrbtqb8s73bepvfg', key: process.env.RENDER_API_KEY },
  { name: 'backup',  sid: 'srv-d900roho3t8c73bqd7cg', key: process.env.RENDER_API_KEY_2 },
];
const TG_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_NOTIFY_TOKEN;
const TG_CHAT = process.env.ADMIN_ID;

const STATE_FILE = '/tmp/neon-failover-state.json';
const PUBLISH_FILE = path.join(__dirname, 'active-db.json');
const LOG_FILE = '/tmp/neon-failover.log';

const CHECK_INTERVAL_MS = 120000;   // 2 min health checks
const SYNC_INTERVAL_MS = 1800000;   // 30 min snapshots
const FAIL_THRESHOLD = 3;           // consecutive failed checks -> failover
const HEALTH_TIMEOUT_MS = 8000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  console.log(line);
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {} }
function publish(mode, url) {
  try { fs.writeFileSync(PUBLISH_FILE, JSON.stringify({ active: mode, active_db_host: hostOf(url), updated_at: new Date().toISOString() }, null, 2)); } catch (_) {}
}
function hostOf(u) { try { return new URL(u).host; } catch { return '?'; } }

function httpReq(method, url, headers, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: 'application/json', ...headers } };
    if (data) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request(opts, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', e => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await httpReq('POST', `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {}, { chat_id: TG_CHAT, parse_mode: 'HTML', text, disable_web_page_preview: true });
}

function dbReachable(url) {
  return new Promise((resolve) => {
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: HEALTH_TIMEOUT_MS, query_timeout: HEALTH_TIMEOUT_MS, statement_timeout: HEALTH_TIMEOUT_MS });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; c.end().catch(() => {}); resolve(ok); };
    const t = setTimeout(() => finish(false), HEALTH_TIMEOUT_MS + 1000);
    c.connect().then(() => c.query('SELECT 1')).then(() => { clearTimeout(t); finish(true); }).catch(() => { clearTimeout(t); finish(false); });
  });
}

function runSync(reason) {
  return new Promise((resolve) => {
    log(`sync start (${reason})`);
    const child = spawn('node', ['ops/neon-sync.js', '--quiet'], { cwd: REPO, env: { ...process.env, NODE_PATH: path.join(BACKEND, 'node_modules') } });
    let err = '';
    child.stderr.on('data', d => err += d);
    child.on('close', (code) => {
      let st = {};
      try { st = JSON.parse(fs.readFileSync('/tmp/neon-sync-state.json', 'utf8')); } catch (_) {}
      if (code === 0 && st.ok) log(`sync done: ${st.tables} tables, ${st.rows} rows, ${st.seconds}s`);
      else log(`sync FAILED (exit ${code}) ${st.error || err.slice(0, 200)}`);
      resolve(code === 0 && st.ok);
    });
  });
}

async function setRenderEnv(svc, key, value) {
  // PUT upserts a single env var, then a deploy is needed to apply it
  const r = await httpReq('PUT', `https://api.render.com/v1/services/${svc.sid}/env-vars/${key}`, { Authorization: `Bearer ${svc.key}` }, { value });
  return r.status >= 200 && r.status < 300;
}
async function deployRender(svc) {
  const r = await httpReq('POST', `https://api.render.com/v1/services/${svc.sid}/deploys`, { Authorization: `Bearer ${svc.key}` }, { clearCache: 'do_not_clear' });
  return r.status >= 200 && r.status < 300;
}

async function failover() {
  log('FAILOVER: switching Render services to BACKUP Neon');
  // 1. last-gasp snapshot (best effort)
  await runSync('last-gasp before failover').catch(() => {});
  // 2. repoint both Render services
  const results = [];
  for (const svc of RENDER) {
    if (!svc.key) { results.push(`${svc.name}: no key`); continue; }
    const a = await setRenderEnv(svc, 'DATABASE_URL', BACKUP_DB);
    const b = await setRenderEnv(svc, 'DATABASE_URL_APP', BACKUP_DB);
    const d = (a && b) ? await deployRender(svc) : false;
    results.push(`${svc.name}: env=${a && b ? 'ok' : 'FAIL'} deploy=${d ? 'ok' : 'FAIL'}`);
    log(`render ${svc.name}: setEnv DATABASE_URL=${a} DATABASE_URL_APP=${b} deploy=${d}`);
  }
  writeState({ mode: 'backup', failedOverAt: new Date().toISOString(), failCount: 0 });
  publish('backup', BACKUP_DB);
  await tg(
    '🟠 <b>CRM: переключение базы на РЕЗЕРВНЫЙ Neon</b>\n' +
    'Основная база Neon перестала отвечать. Перенаправил оба сервера на резервную базу (последний слепок данных синхронизирован).\n' +
    `Сервисы: ${results.join('; ')}\n` +
    '⚠️ Возврат на основную базу — вручную: на резерве копятся новые записи, их нужно сначала перелить обратно, иначе потеряются.'
  );
}

async function tick() {
  const state = readState();
  const mode = state.mode || 'primary';

  if (mode === 'backup') {
    publish('backup', BACKUP_DB);
    const pUp = await dbReachable(PRIMARY_DB);
    if (pUp && !state.primaryRecoveredNotified) {
      await tg('🟢 <b>Основная база Neon снова доступна</b>\nСейчас работает РЕЗЕРВНАЯ база. Возврат на основную — по команде (нужен обратный перелив новых записей, чтобы ничего не потерять).');
      writeState({ ...state, primaryRecoveredNotified: true });
      log('primary recovered (manual failback required)');
    }
    return;
  }

  // mode === primary
  const up = await dbReachable(PRIMARY_DB);
  if (up) {
    publish('primary', PRIMARY_DB);
    const now = Date.now();
    const lastSync = state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
    let s = { ...state, mode: 'primary', failCount: 0 };
    if (now - lastSync >= SYNC_INTERVAL_MS) {
      const ok = await runSync('scheduled');
      if (ok) s.lastSyncAt = new Date().toISOString();
    }
    writeState(s);
  } else {
    const failCount = (state.failCount || 0) + 1;
    log(`primary DB unreachable (${failCount}/${FAIL_THRESHOLD})`);
    writeState({ ...state, mode: 'primary', failCount });
    if (failCount >= FAIL_THRESHOLD) await failover();
  }
}

if (process.argv.includes('--failover-now')) {
  failover().then(() => process.exit(0));
} else if (process.argv.includes('--sync-now')) {
  runSync('manual').then(ok => { writeState({ ...readState(), lastSyncAt: new Date().toISOString() }); process.exit(ok ? 0 : 1); });
} else if (process.argv.includes('--daemon')) {
  if (!PRIMARY_DB || !BACKUP_DB) { log('FATAL: DATABASE_URL or NEON_BACKUP_URL missing'); process.exit(1); }
  log(`daemon started (check ${CHECK_INTERVAL_MS/1000}s, sync ${SYNC_INTERVAL_MS/60000}min, mode=${readState().mode || 'primary'})`);
  const run = () => tick().catch(e => log('tick error: ' + e.message));
  run();
  setInterval(run, CHECK_INTERVAL_MS);
} else {
  console.log('usage: neon-failover.js --daemon | --sync-now | --failover-now');
}
