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

module.exports = { createSnapshot, runBackup, s3Configured: s3.isConfigured };
