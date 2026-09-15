#!/usr/bin/env node
/**
 * Восстановление master_schedule_days в состояние ночного бэкапа 2026-09-15 03:30,
 * т.е. ДО массовой генерации графиков (10:28 и 11:22) — заметка CRM #156.
 *
 * Безопасность: перед изменением делается полный снимок текущей таблицы
 * в master_schedule_days_bak_20260915 (откат отката возможен).
 *
 * Запуск: DOTENV_CONFIG_PATH=backend/.env node -r dotenv/config ops/restore-schedule-20260915.js [--apply]
 * Без --apply — только показывает diff.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BACKEND = path.join(__dirname, '..', 'backend');
const { Client } = require(path.join(BACKEND, 'node_modules/pg'));

const SRC = path.join(process.env.HOME, 'workspace/.db-backups/2026-09-15/master_schedule_days.ndjson.gz');
const APPLY = process.argv.includes('--apply');
const BAK_TABLE = 'master_schedule_days_bak_20260915';

(async () => {
  const rows = zlib.gunzipSync(fs.readFileSync(SRC)).toString('utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`Бэкап: ${rows.length} строк`);

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect();

  const cur = await c.query(`SELECT id, master_id, to_char(work_date,'YYYY-MM-DD') AS work_date, start_time, end_time, source FROM master_schedule_days`);
  console.log(`Сейчас в базе: ${cur.rows.length} строк`);

  const key = (r) => `${r.master_id}|${String(r.work_date).slice(0, 10)}`;
  const bakMap = new Map(rows.map((r) => [key(r), r]));
  const curMap = new Map(cur.rows.map((r) => [key(r), r]));

  const norm = (v) => (v === null || v === undefined ? null : String(v).slice(0, 8));
  let added = 0, changed = 0, missing = 0;
  for (const [k, r] of curMap) {
    const b = bakMap.get(k);
    if (!b) { added++; continue; }
    if (norm(r.start_time) !== norm(b.start_time) || norm(r.end_time) !== norm(b.end_time)) changed++;
  }
  for (const k of bakMap.keys()) if (!curMap.has(k)) missing++;

  console.log(`Появилось после бэкапа (будет удалено): ${added}`);
  console.log(`Изменено после бэкапа (будет возвращено): ${changed}`);
  console.log(`Пропало после бэкапа (будет восстановлено): ${missing}`);

  if (!APPLY) { console.log('DRY-RUN. Для применения: --apply'); await c.end(); return; }

  await c.query('BEGIN');
  try {
    await c.query(`DROP TABLE IF EXISTS ${BAK_TABLE}`);
    await c.query(`CREATE TABLE ${BAK_TABLE} AS SELECT * FROM master_schedule_days`);
    const snap = await c.query(`SELECT count(*) n FROM ${BAK_TABLE}`);
    console.log(`Снимок текущего состояния: ${snap.rows[0].n} строк -> ${BAK_TABLE}`);

    await c.query('TRUNCATE master_schedule_days');

    const CH = 500;
    for (let i = 0; i < rows.length; i += CH) {
      const chunk = rows.slice(i, i + CH);
      const vals = [];
      const ph = chunk.map((r, j) => {
        const o = j * 7;
        vals.push(r.id, r.master_id, String(r.work_date).slice(0, 10), r.start_time, r.end_time, r.source, r.synced_at);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4}::time,$${o + 5}::time,$${o + 6},$${o + 7})`;
      }).join(',');
      await c.query(
        `INSERT INTO master_schedule_days (id, master_id, work_date, start_time, end_time, source, synced_at) VALUES ${ph}`,
        vals,
      );
    }
    await c.query(`SELECT setval(pg_get_serial_sequence('master_schedule_days','id'), COALESCE((SELECT MAX(id) FROM master_schedule_days),1))`);
    await c.query('COMMIT');
    const after = await c.query('SELECT count(*) n FROM master_schedule_days');
    console.log(`ГОТОВО. В таблице теперь ${after.rows[0].n} строк (ожидалось ${rows.length})`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ОШИБКА, откат:', e.message);
    process.exitCode = 1;
  }
  await c.end();
})();
