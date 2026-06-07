#!/usr/bin/env node
/* ════════════════════════════════════════════
   SVS Beauty World — JSON snapshot backup
   Записывает все таблицы в один .json.gz файл.
   Используется вместо pg_dump (его нет в этой среде).
   Ротация: оставляет последние 14 снапшотов.
   ════════════════════════════════════════════ */
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Pool } = require('pg');

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
  if (!process.env.DATABASE_URL) {
    console.error('[backup] DATABASE_URL missing');
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const snapshot = { meta: { created_at: new Date().toISOString(), version: 1 }, tables: {} };
  let totalRows = 0;
  for (const t of TABLES) {
    try {
      const r = await pool.query(`SELECT * FROM ${t}`);
      snapshot.tables[t] = r.rows;
      totalRows += r.rows.length;
      console.log(`[backup] ${t}: ${r.rows.length} rows`);
    } catch (e) {
      console.error(`[backup] ${t}: ${e.message}`);
      snapshot.tables[t] = { error: e.message };
    }
  }
  await pool.end();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const out = path.join(BACKUP_DIR, `snapshot-${ts}.json.gz`);
  const buf = Buffer.from(JSON.stringify(snapshot));
  fs.writeFileSync(out, zlib.gzipSync(buf, { level: 9 }));
  const size = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`[backup] wrote ${out} (${size} KB, ${totalRows} rows)`);

  // Ротация
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.json.gz'))
    .map(f => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const toDelete = files.slice(KEEP);
  for (const x of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, x.f));
    console.log(`[backup] rotated out: ${x.f}`);
  }
  console.log(`[backup] kept: ${Math.min(files.length, KEEP)} files`);
})().catch(e => { console.error('[backup] fatal:', e.message); process.exit(2); });
