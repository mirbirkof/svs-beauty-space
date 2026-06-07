#!/usr/bin/env node
/*
 * BP Sync — масова синхронізація клієнтів з BeautyPro
 *
 * Запуск:
 *   node scripts/bp-sync-clients.js           — синхро всіх unlinked (макс 50)
 *   node scripts/bp-sync-clients.js --phone X — синхро одного по телефону
 *   node scripts/bp-sync-clients.js --all     — без ліміту
 *   node scripts/bp-sync-clients.js --status  — тільки звіт
 *
 * Cron приклад: кожні 15 хв (зразок з зірочками — див README)
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { syncOneClient, bpSearchByPhone } = require('../routes/beautypro-sync-v2');
const { getPool } = require('../db-pg');

function normalizePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 9) return '380' + d;
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  const pool = getPool();

  // --status
  if (args.includes('--status')) {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE beautypro_id IS NOT NULL) AS linked,
         COUNT(*) FILTER (WHERE beautypro_id IS NULL) AS unlinked,
         COUNT(*) AS total
       FROM clients WHERE phone IS NOT NULL`
    );
    console.log('Sync status:', r.rows[0]);
    await pool.end();
    return;
  }

  // --phone
  const phoneIdx = args.indexOf('--phone');
  if (phoneIdx !== -1 && args[phoneIdx + 1]) {
    const phone = normalizePhone(args[phoneIdx + 1]);
    console.log(`Searching/syncing phone: ${phone}`);
    let r = await pool.query('SELECT id, phone, name, email FROM clients WHERE phone = $1', [phone]);
    let local = r.rows[0];
    if (!local) {
      const ins = await pool.query(
        `INSERT INTO clients (phone, source) VALUES ($1,'bp-cli') RETURNING id, phone, name, email`,
        [phone]
      );
      local = ins.rows[0];
      console.log('  Created local stub:', local.id);
    }
    const out = await syncOneClient(local);
    console.log('  Result:', out);
    await pool.end();
    return;
  }

  // Batch sync
  const limit = args.includes('--all') ? 500 : 50;
  const r = await pool.query(
    `SELECT id, phone, name, email FROM clients
     WHERE beautypro_id IS NULL AND phone IS NOT NULL LIMIT $1`,
    [limit]
  );
  console.log(`Batch sync: ${r.rows.length} clients to process`);

  let ok = 0, fail = 0;
  for (const c of r.rows) {
    const out = await syncOneClient(c);
    if (out.ok) {
      ok++;
      console.log(`  [✓] ${c.phone}  ${out.action}  bp=${out.bp_id}`);
    } else {
      fail++;
      console.log(`  [✗] ${c.phone}  ${out.error}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`\nDone: ${ok} OK, ${fail} failed, total ${r.rows.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
