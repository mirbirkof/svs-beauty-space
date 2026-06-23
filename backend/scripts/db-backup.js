#!/usr/bin/env node
/* ════════════════════════════════════════════
   SVS Beauty World — полный снимок БД (все тенанты).
   Делает gzip-снимок таблиц, пишет локально и выгружает в S3-совместимое
   хранилище (если заданы BACKUP_S3_* в окружении). Ротация: последние 14.
   pg_dump в этой среде нет → снимок в JSON.gz через lib/backup-core.
   ════════════════════════════════════════════ */
require('dotenv').config({ path: __dirname + '/../.env' });
const path = require('path');
const { Pool } = require('pg');
const { runBackup } = require('../lib/backup-core');

const BACKUP_DIR = path.resolve(__dirname, '../../backups');
const KEEP = 14;

const TABLES = [
  'brands', 'category_groups', 'categories',
  'products', 'product_variants', 'stock_movements',
  'clients', 'sessions', 'sms_codes',
  'orders', 'order_items',
  'promos', 'promo_redemptions',
  'loyalty_movements',
];

(async () => {
  const url = process.env.DATABASE_URL || process.env.DATABASE_URL_APP;
  if (!url) { console.error('[backup] DATABASE_URL missing'); process.exit(1); }
  // Полный бэкаповый прогон идёт под основной ролью (без RLS) → все тенанты.
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const out = await runBackup({
      queryFn: (text, params) => pool.query(text, params),
      tables: TABLES, label: 'snapshot', localDir: BACKUP_DIR, keep: KEEP, uploadToS3: true,
    });
    console.log(`[backup] ${out.filename}: ${out.rows} rows, ${(out.size_bytes / 1024).toFixed(1)} KB`);
    console.log(out.uploaded
      ? `[backup] uploaded offsite → ${out.artifact_path}`
      : `[backup] LOCAL ONLY (эфемерно): задайте BACKUP_S3_* для выгрузки во внешнее хранилище`);
  } finally {
    await pool.end();
  }
})().catch(e => { console.error('[backup] fatal:', e.message); process.exit(2); });
