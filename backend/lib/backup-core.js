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

  // Пре-фильтр: оставляем только реально существующие таблицы. Защита от дрейфа схемы —
  // чтобы переименованная/удалённая таблица не превращалась в молчаливый {error} внутри снимка.
  let useTables = tables;
  let skipped = [];
  try {
    const ex = await queryFn(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name = ANY($1)`, [tables]);
    const exist = new Set(ex.rows.map(r => r.table_name));
    useTables = tables.filter(t => exist.has(t));
    skipped = tables.filter(t => !exist.has(t));
    if (skipped.length) console.warn('[backup] таблицы отсутствуют в схеме, пропущены:', skipped.join(', '));
  } catch (_) { /* если introspection недоступна — снимаем как есть */ }

  const { buffer, meta } = await createSnapshot(queryFn, useTables);
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
    skipped_tables: skipped,
  };
}

// Таблицы для снимка. ВАЖНО: имена сверены со схемой прода (information_schema).
// Раньше список содержал несуществующие category_groups/promo_redemptions/loyalty_movements —
// бэкап молча писал {error} и НЕ сохранял баллы лояльности. Исправлено на реальные имена.
// runBackup дополнительно пре-фильтрует список по факту существования (защита от дрейфа схемы).
const BACKUP_TABLES = [
  // Каталог/склад
  'brands', 'categories', 'service_categories', 'services',
  'products', 'product_variants', 'stock_movements', 'material_norms',
  // Клиенты/лояльность
  'clients', 'client_loyalty', 'loyalty_ledger', 'loyalty_tiers',
  'gift_certificates', 'gift_certificate_transactions',
  'subscriptions', 'subscription_usage',
  // Магазин
  'orders', 'order_items', 'payments',
  'promos', 'promotions', 'promo_codes_saas',
  // Записи/расписание (аудит v6: раньше отсутствовали online_bookings/материалы)
  'appointments', 'appointment_materials', 'online_bookings', 'waitlist',
  'masters', 'master_schedule_days',
  // ДЕНЬГИ — критично, раньше НЕ бэкапились (аудит v6):
  'cash_operations', 'cash_shifts', 'shift_checklists', 'expense_confirmations',
  'payroll_records', 'payroll_payments', 'payroll_advances', 'payroll_bonuses',
  'payroll_penalties', 'payroll_partial_payments', 'payroll_rules', 'payroll_schemes',
  // SaaS-биллинг
  'invoices_saas', 'subscriptions_saas', 'payments_saas',
  // Доступы
  'users', 'roles',
  'sessions', 'sms_codes',
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

/**
 * Загружает gzip-снимок: либо из локального файла, либо из S3 по ключу.
 * @param {{localPath?:string, s3Key?:string}} src
 * @returns {Promise<Buffer>} распакованный JSON-буфер снимка
 */
async function loadSnapshot(src = {}) {
  let gz;
  if (src.localPath) {
    gz = fs.readFileSync(src.localPath);
  } else if (src.s3Key) {
    gz = await s3.getObject(src.s3Key);
  } else {
    throw new Error('loadSnapshot: нужен localPath или s3Key');
  }
  return zlib.gunzipSync(gz);
}

/**
 * Проверяет восстановимость снимка БЕЗ записи в БД (dry-run).
 * Распаковывает, парсит JSON, считает строки по таблицам, ловит битые таблицы.
 * Это закрывает дыру «бэкап есть, но никто не знает восстановим ли он».
 * @param {{localPath?:string, s3Key?:string, buffer?:Buffer}} src
 */
async function validateSnapshot(src = {}) {
  const raw = src.buffer || await loadSnapshot(src);
  let snap;
  try { snap = JSON.parse(raw.toString()); }
  catch (e) { return { ok: false, error: 'parse-failed: ' + e.message }; }

  const tables = snap.tables || {};
  const counts = {};
  const broken = [];
  const empty = [];
  let total = 0;
  for (const [t, rows] of Object.entries(tables)) {
    if (Array.isArray(rows)) {
      counts[t] = rows.length;
      total += rows.length;
      if (rows.length === 0) empty.push(t);
    } else {
      counts[t] = -1;
      broken.push(t);
    }
  }
  return {
    ok: broken.length === 0 && total > 0,
    created_at: snap.meta?.created_at || null,
    version: snap.meta?.version || null,
    total_rows: total,
    table_count: Object.keys(counts).length,
    tables: counts,
    broken,
    empty,
  };
}

module.exports = {
  createSnapshot, runBackup, startCron, BACKUP_TABLES,
  loadSnapshot, validateSnapshot, s3Configured: s3.isConfigured,
};
