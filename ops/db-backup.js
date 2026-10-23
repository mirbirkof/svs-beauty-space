#!/usr/bin/env node
/**
 * db-backup.js — ночной дамп данных прод-базы (Supabase) на локальный диск.
 * Заменил neon-failover/neon-sync (отключены 13.07.2026 — Neon больше не используем).
 *
 * Что делает:
 *  - все BASE TABLE из public → NDJSON.gz в ~/workspace/.db-backups/YYYY-MM-DD/
 *  - схема НЕ дампится: полная схема живёт в backend/migrations/*.sql
 *  - ретеншн (23.10, аудит п.3): ежедневные 30 дней + первая копия каждого месяца 13 месяцев
 *    (было 7 дней — неделя без замеченной беды = история потеряна). Вне сервера: ops/db-backup-offsite.sh
 *
 * Восстановление: прогнать миграции на чистой базе, затем загрузить NDJSON
 * (INSERT построчно, сессия с session_replication_role=replica чтобы не мешали FK/триггеры).
 *
 * Запуск: node -r dotenv/config ops/db-backup.js  (DOTENV_CONFIG_PATH=backend/.env)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BACKEND = path.join(__dirname, '..', 'backend');
const { Client } = require(path.join(BACKEND, 'node_modules/pg'));

const OUT_ROOT = path.join(process.env.HOME, 'workspace/.db-backups');
const KEEP_DAYS = 30;          // ежедневные
const KEEP_MONTHLY_DAYS = 400; // первая копия каждого месяца
const LOG_FILE = '/tmp/db-backup.log';

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}


// Аудит 13.08: раніше провал бекапу лишався РЯДКОМ У /tmp-лозі, який ніхто не читає —
// бекапи могли падати місяцями непоміченими. Тепер про провал одразу знає Бос.
function notifyBoss(text) {
  try {
    const body = JSON.stringify({ text });
    const req = require('http').request({
      host: '127.0.0.1', port: 3005, path: '/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 'x-restart-token': 'x', 'x-notify-token': process.env.RESTART_TOKEN || 'jarvis-restart-2026' },
      timeout: 8000,
    });
    req.on('error', () => {}); req.write(body); req.end();
  } catch (_) {}
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { log('FATAL: DATABASE_URL не задан'); process.exit(1); }

  const day = new Date().toISOString().slice(0, 10);
  const outDir = path.join(OUT_ROOT, day);
  fs.mkdirSync(outDir, { recursive: true });

  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect();
  log(`backup start -> ${outDir}`);

  const tables = (await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
  )).rows.map(r => r.table_name);

  let ok = 0, fail = 0, rowsTotal = 0;
  for (const t of tables) {
    try {
      const r = await c.query(`SELECT row_to_json(x) j FROM "${t}" x`);
      const nd = r.rows.map(x => JSON.stringify(x.j)).join('\n');
      fs.writeFileSync(path.join(outDir, `${t}.ndjson.gz`), zlib.gzipSync(nd));
      ok++; rowsTotal += r.rows.length;
    } catch (e) {
      fail++; log(`table ${t} FAILED: ${e.message.slice(0, 120)}`);
    }
  }
  await c.end();

  // Ретеншн: ежедневные — KEEP_DAYS; самая ранняя копия каждого месяца — KEEP_MONTHLY_DAYS.
  // Только внутри OUT_ROOT, только формат YYYY-MM-DD.
  const now = Date.now();
  const days = fs.readdirSync(OUT_ROOT).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const firstOfMonth = new Set();
  const seenMonth = new Set();
  for (const d of days) { const m = d.slice(0, 7); if (!seenMonth.has(m)) { seenMonth.add(m); firstOfMonth.add(d); } }
  for (const d of days) {
    const age = now - new Date(d + 'T00:00:00Z').getTime();
    const keep = age < KEEP_DAYS * 86400000 || (firstOfMonth.has(d) && age < KEEP_MONTHLY_DAYS * 86400000);
    if (!keep) {
      fs.rmSync(path.join(OUT_ROOT, d), { recursive: true, force: true });
      log(`retention: удалён ${d}`);
    }
  }

  const size = fs.readdirSync(outDir).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
  log(`backup done: ${ok} таблиц OK, ${fail} FAIL, ${rowsTotal} строк, ${(size / 1048576).toFixed(1)} MB`);
  if (fail > 0) notifyBoss(`🔴 <b>Бекап бази CRM: ${fail} таблиць НЕ збереглися</b>\nЗбережено ${ok}, розмір ${(size / 1048576).toFixed(1)} MB. Перевір /tmp/db-backup.log`);
  if (size < 1048576) notifyBoss(`🔴 <b>Бекап бази CRM підозріло малий</b>: ${(size / 1048576).toFixed(2)} MB (звично ~6-7 MB). Схоже, збереглася не вся база.`);
  setTimeout(() => process.exit(fail > 0 ? 2 : 0), fail > 0 || size < 1048576 ? 1500 : 0);
})().catch(e => { log(`FATAL: ${e.message}`); notifyBoss(`🔴 <b>Бекап бази CRM ВПАВ</b>: ${e.message}`); setTimeout(() => process.exit(1), 1500); });
