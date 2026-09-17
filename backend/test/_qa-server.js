// Общий помощник тестов: поднять CRM ОТДЕЛЬНЫМ процессом поверх QA-базы (Neon-песочница).
// Никогда не прод: DATABASE_URL подменяется на QA_DB_URL, рассылки/кроны заглушены (QA_STAGING=1),
// боевые токены Telegram/Mono пустые, admin-токен одноразовый.
// node --test гоняет файлы параллельно → у каждого файла СВОЙ порт (pay-cycle 3037, contracts 3038).
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

async function startQaServer({ port, extraEnv = {}, bootMs = 120000 } = {}) {
  const QA_URL = process.env.QA_DB_URL;
  if (!QA_URL) throw new Error('QA_DB_URL не задан');
  const token = 'qa-' + crypto.randomBytes(12).toString('hex');
  const env = {
    ...process.env,
    DATABASE_URL: QA_URL, DATABASE_URL_APP: QA_URL,
    PORT: String(port), SHOP_API_PORT: String(port),
    QA_STAGING: '1', CRM_REUSEPORT: '', CRM_DEFER_JOBS: '1', CRM_PROBE_PORT: '',
    ADMIN_TOKEN: token, ADMIN_TOKEN_BOOTSTRAP_ONLY: '',
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_NOTIFY_TOKEN: '', MONO_TOKEN: '', SENTRY_DSN: '',
    NODE_ENV: 'development',
    ...extraEnv,
  };
  let log = '';
  const srv = spawn(process.execPath, ['shop-api.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d) => { log += d; if (log.length > 200000) log = log.slice(-100000); };
  srv.stdout.on('data', keep); srv.stderr.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + bootMs;
  while (Date.now() < until) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (_) {}
    if (srv.exitCode !== null) throw new Error('QA-сервер упал на старте:\n' + log.slice(-1500));
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (Date.now() >= until) throw new Error('QA-сервер не поднялся за ' + bootMs + 'мс:\n' + log.slice(-1500));
  return {
    base, token, srv,
    log: () => log,
    stop() { if (srv.exitCode === null) { try { srv.kill('SIGTERM'); } catch (_) {} } },
  };
}

module.exports = { startQaServer };
