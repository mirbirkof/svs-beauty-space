#!/usr/bin/env node
/* Staging-runner: поднимает backend на изолированной Neon-ветке qa-sandbox.
   Сюда fix-worker выкатывает исправленный код, и QA гоняет тесты ПРОТИВ staging —
   до боевой CRM правки не доходят, пока не пройдут проверку в песочнице.

   Безопасность: staging бьёт ТОЛЬКО в qa-sandbox БД. Фоновые кроны/внешние синки
   (BeautyPro, биллинг, keepalive) глушим через QA_STAGING=1 — staging только отвечает
   на запросы тестов, ничего наружу не пишет.

   Использование:
     node staging.js start   — поднять (порт QA_STAGING_PORT, деф. 3025)
     node staging.js stop     — остановить (по pid-файлу)
     node staging.js health   — проверить готовность
*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const PORT = Number(process.env.QA_STAGING_PORT || 3025);
// backend можно поднять из любой копии кода (worktree с фиксом) — задаётся QA_STAGING_BACKEND
const BACKEND = process.env.QA_STAGING_BACKEND || path.join(__dirname, '../backend/shop-api.js');
const PIDFILE = path.join(cfg.dataDir, 'staging.pid');
const LOG = '/tmp/qa-staging.log';
const BASE = `http://127.0.0.1:${PORT}`;

function isUp() {
  return new Promise((resolve) => {
    const req = require('http').get(`${BASE}/health`, { timeout: 3000 }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(r.statusCode === 200));
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function start() {
  if (!cfg.qaDbUrl) { console.error('[staging] нет qaDbUrl — песочница не настроена'); process.exit(1); }
  if (await isUp()) { console.log('[staging] уже поднят на', BASE); return; }
  const env = { ...process.env,
    DATABASE_URL: cfg.qaDbUrl,     // ← только песочница
    PORT: String(PORT),
    SHOP_API_PORT: String(PORT),   // backend отдаёт приоритет SHOP_API_PORT (из .env) — переопределяем
    ADMIN_TG_CHAT: '',             // глушим telegram-уведомления staging (кроны на node-cron)
    BOT_TOKEN: '', WIFE_BOT_TOKEN: '', // никаких внешних отправок из песочницы
    NODE_ENV: 'staging',
    QA_STAGING: '1',               // флаг: backend глушит кроны/внешние синки (см. shop-api.js guard)
    ADMIN_TOKEN_BOOTSTRAP_ONLY: '0',
  };
  const out = fs.openSync(LOG, 'a');
  const child = spawn('node', [BACKEND], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  // ждём готовности до 30с
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp()) { console.log('[staging] поднят на', BASE, 'pid', child.pid); return; }
  }
  console.error('[staging] не поднялся за 30с — смотри', LOG); process.exit(1);
}

function stop() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PIDFILE);
    console.log('[staging] остановлен pid', pid);
  } catch (e) { console.log('[staging] нечего останавливать:', e.message); }
}

(async () => {
  const cmd = process.argv[2] || 'health';
  if (cmd === 'start') await start();
  else if (cmd === 'stop') stop();
  else console.log('[staging]', (await isUp()) ? 'UP ' + BASE : 'DOWN');
})();
