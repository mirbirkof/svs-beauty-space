// Воркер авто-начисления бонусов ко дню рождения
// Запуск раз в сутки в 09:00. Использует API /api/loyalty/birthday/credit
const http = require('http');

const API_HOST = '127.0.0.1';
const API_PORT = 3012;
const RUN_HOUR = 9; // 09:00 локально

function call(path, method = 'POST') {
  return new Promise((resolve) => {
    const req = http.request({ host: API_HOST, port: API_PORT, path, method, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

async function tick() {
  const r = await call('/api/loyalty/birthday/credit');
  const ts = new Date().toISOString();
  console.log(`[bday-cron] ${ts} status=${r.status} body=${(r.body||r.error||'').slice(0,200)}`);
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(RUN_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function schedule() {
  const wait = msUntilNextRun();
  console.log(`[bday-cron] next run in ${Math.round(wait/1000/60)} min`);
  setTimeout(async () => {
    await tick();
    schedule();
  }, wait);
}

// Стартовый прогон чтобы убедиться что endpoint работает
(async () => {
  await tick();
  schedule();
})();
