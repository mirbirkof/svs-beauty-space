#!/usr/bin/env node
/**
 * db-backup.js — ночной дамп данных прод-базы (Supabase) на локальный диск.
 * Заменил neon-failover/neon-sync (отключены 13.07.2026 — Neon больше не используем).
 *
 * Что делает:
 *  - все BASE TABLE из public → NDJSON.gz в ~/workspace/.db-backups/YYYY-MM-DD/
 *  - схема НЕ дампится: полная схема живёт в backend/migrations/*.sql
 *  - ретеншн: папки старше 7 дней удаляются
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
const KEEP_DAYS = 7;
const LOG_FILE = '/tmp/db-backup.log';

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
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

  // Ретеншн: удалить папки старше KEEP_DAYS (только внутри OUT_ROOT, только формат YYYY-MM-DD)
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const d of fs.readdirSync(OUT_ROOT)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (new Date(d + 'T00:00:00Z').getTime() < cutoff) {
      fs.rmSync(path.join(OUT_ROOT, d), { recursive: true, force: true });
      log(`retention: удалён ${d}`);
    }
  }

  const size = fs.readdirSync(outDir).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
  log(`backup done: ${ok} таблиц OK, ${fail} FAIL, ${rowsTotal} строк, ${(size / 1048576).toFixed(1)} MB`);
  process.exit(fail > 0 ? 2 : 0);
})().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
