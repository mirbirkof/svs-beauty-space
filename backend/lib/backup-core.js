/* ════════════════════════════════════════════════════════════════
   Ядро резервного копирования (аудит: «backup — заглушка»).
   Делает реальный gzip-снимок данных, пишет локально и (если настроено)
   выгружает в S3-совместимое хранилище. Используется и cron-скриптом
   (scripts/db-backup.js), и HTTP-роутом (routes/backup.js POST /run).

   pg_dump в среде Render недоступен, поэтому снимок — это JSON всех строк
   нужных таблиц, сжатый gzip. Для восстановления достаточно распаковать и
   загрузить строки обратно (плюс платформенный PITR Neon/Render как второй слой).
   ════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const s3 = require('./s3-upload');

/**
 * Снимает данные таблиц и возвращает сжатый буфер + метаданные.
 * @param {(text:string, params?:any[])=>Promise<{rows:any[]}>} queryFn
 * @param {string[]} tables
 */
async function createSnapshot(queryFn, tables) {
  const snapshot = { meta: { created_at: new Date().toISOString(), version: 2 }, tables: {} };
  let totalRows = 0;
  const okTables = [];
  const hash = crypto.createHash('sha256');
  for (const t of tables) {
    try {
      const r = await queryFn(`SELECT * FROM ${t}`);
      snapshot.tables[t] = r.rows;
      totalRows += r.rows.length;
      okTables.push(t);
      hash.update(`${t}:${r.rows.length};`);
    } catch (e) {
      snapshot.tables[t] = { error: e.message };
    }
  }
  const raw = Buffer.from(JSON.stringify(snapshot));
  const buffer = zlib.gzipSync(raw, { level: 9 });
  return {
    buffer,
    meta: {
      created_at: snapshot.meta.created_at,
      rows: totalRows,
      tables: okTables.length,
      raw_bytes: raw.length,
      gzip_bytes: buffer.length,
      checksum: hash.digest('hex').slice(0, 32),
    },
  };
}

/**
 * Полный прогон: снимок → локальный файл → выгрузка в S3 (если настроено) → ротация.
 * @returns {Promise<{filename,localPath,size_bytes,rows,tables,checksum,artifact_path,uploaded}>}
 */
async function runBackup({ queryFn, tables, label = 'snapshot', localDir, keep = 14, uploadToS3 = true }) {
  const dir = localDir || path.resolve(__dirname, '../../backups');
  fs.mkdirSync(dir, { recursive: true });

  const { buffer, meta } = await createSnapshot(queryFn, tables);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `${label}-${ts}.json.gz`;
  const localPath = path.join(dir, filename);
  fs.writeFileSync(localPath, buffer);

  // Выгрузка во внешнее хранилище (главная защита — переживает рестарт Render)
  let artifactPath = `local:${localPath}`;
  let uploaded = false;
  if (uploadToS3 && s3.isConfigured()) {
    const res = await s3.uploadObject(filename, buffer, 'application/gzip');
    artifactPath = res.url;
    uploaded = true;
  }

  // Ротация локальных файлов
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${label}-`) && f.endsWith('.json.gz'))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const x of files.slice(keep)) fs.unlinkSync(path.join(dir, x.f));
  } catch (_) {}

  return {
    filename,
    localPath,
    size_bytes: meta.gzip_bytes,
    rows: meta.rows,
    tables: meta.tables,
    checksum: meta.checksum,
    artifact_path: artifactPath,
    uploaded,
  };
}

// Таблицы для снимка (синхронно со scripts/db-backup.js).
const BACKUP_TABLES = [
  'brands', 'category_groups', 'categories',
  'products', 'product_variants', 'stock_movements',
  'clients', 'sessions', 'sms_codes',
  'orders', 'order_items',
  'promos', 'promo_redemptions',
  'loyalty_movements',
];

/**
 * In-process суточный планировщик offsite-бэкапа.
 * Запускается из shop-api при старте. Раз в день (целевой час UTC, по умолч. 3:xx)
 * делает снимок всех тенантов под основной ролью (без RLS) и выгружает в S3.
 * Если внешнее хранилище не настроено (нет BACKUP_S3_*) — тихо пропускает,
 * т.к. локальный диск Render эфемерный и смысла в нём нет.
 */
function startCron({ hourUTC = 3, intervalMs = 30 * 60 * 1000 } = {}) {
  if (!s3.isConfigured()) {
    console.log('[backup] cron disabled: BACKUP_S3_* не заданы (offsite-хранилище не настроено)');
    return null;
  }
  const url = process.env.DATABASE_URL || process.env.DATABASE_URL_APP;
  if (!url) { console.log('[backup] cron disabled: DATABASE_URL missing'); return null; }

  const { Pool } = require('pg');
  let pool = null;
  let lastRunDate = null; // 'YYYY-MM-DD' последнего успешного прогона
  let running = false;

  async function maybeRun() {
    if (running) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (lastRunDate === today) return;          // уже сделали сегодня
    if (now.getUTCHours() < hourUTC) return;    // ещё не наступил целевой час
    running = true;
    try {
      if (!pool) pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
      const out = await runBackup({
        queryFn: (text, params) => pool.query(text, params),
        tables: BACKUP_TABLES, label: 'snapshot', keep: 14, uploadToS3: true,
      });
      lastRunDate = today;
      console.log(out.uploaded
        ? `[backup] cron offsite OK → ${out.artifact_path} (${out.rows} rows, ${(out.size_bytes / 1024).toFixed(1)} KB)`
        : `[backup] cron LOCAL ONLY (offsite не сработал)`);
    } catch (e) {
      console.error('[backup] cron failed:', e.message); // не валим процесс, повторим через интервал
    } finally {
      running = false;
    }
  }

  const timer = setInterval(maybeRun, intervalMs);
  if (timer.unref) timer.unref();
  // первая проверка вскоре после старта (на случай если уже > hourUTC и сегодня не делали)
  const kick = setTimeout(maybeRun, 60 * 1000);
  if (kick.unref) kick.unref();
  console.log(`[backup] cron enabled: ежедневно после ${hourUTC}:00 UTC, проверка каждые ${Math.round(intervalMs/60000)} мин`);
  return timer;
}

module.exports = { createSnapshot, runBackup, startCron, BACKUP_TABLES, s3Configured: s3.isConfigured };
