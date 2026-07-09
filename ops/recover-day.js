#!/usr/bin/env node
/* Восстановление «застрявшего дня» после аварии 08.07.2026.
   Касса и закрытия визитов за 8 июля остались в PRIMARY (ep-old-forest),
   который закрыт квотой трафика Neon. Скрипт: как только primary отвечает —
   переносит в ЖИВУЮ базу (backup, ep-wild-fire):
     1) cash_operations за 08.07 (INSERT по id, ON CONFLICT DO NOTHING — без дублей);
     2) статусы/суммы визитов 08.07 (UPDATE только если в живой базе визит «моложе»);
     3) строки услуг визитов 08.07 (appointment_services, по id).
   Запуск: node ops/recover-day.js [YYYY-MM-DD]   (по умолчанию 2026-07-08)
   Идемпотентен — можно гонять сколько угодно. */
const fs = require('fs');
const path = require('path');
const { Client } = require(path.join(__dirname, '../backend/node_modules/pg'));
for (const p of [path.join(__dirname, '../backend/.env')]) {
  try { for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]; } } catch (_) {}
}
const DAY = process.argv[2] || '2026-07-08';
const PRIMARY = process.env.DATABASE_URL_APP; // ep-old-forest (app_tenant, без GUC видит всё)
const LIVE = process.env.NEON_BACKUP_URL || process.env.DATABASE_URL; // ep-wild-fire owner

(async () => {
  const pri = new Client({ connectionString: PRIMARY, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000, statement_timeout: 20000 });
  try { await pri.connect(); await pri.query('SELECT 1'); }
  catch (e) { console.log('PRIMARY_DOWN: ' + e.message.slice(0, 70)); process.exit(2); }
  const live = new Client({ connectionString: LIVE, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  await live.connect();

  // 1) касса дня
  const ops = (await pri.query(
    `SELECT * FROM cash_operations WHERE (created_at AT TIME ZONE 'Europe/Kiev')::date = $1::date`, [DAY])).rows;
  let insOps = 0;
  for (const o of ops) {
    const cols = Object.keys(o);
    const params = cols.map((_, i) => '$' + (i + 1));
    const r = await live.query(
      `INSERT INTO cash_operations (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${params.join(',')})
       ON CONFLICT (id) DO NOTHING`, cols.map(c => o[c])).catch(e => ({ rowCount: 0, err: e.message }));
    if (r.rowCount) insOps++;
    else if (r.err) console.log('op#' + o.id + ' skip: ' + r.err.slice(0, 60));
  }
  // сиквенс кассы — выше максимума (чтобы новые операции не конфликтовали)
  await live.query(`SELECT setval('cash_operations_id_seq', GREATEST((SELECT MAX(id) FROM cash_operations), 1), true)`).catch(() => {});

  // 2) визиты дня: статус/суммы (не трогаем, если в живой уже не booked — там новее)
  const appts = (await pri.query(
    `SELECT id, status, real_amount, price, pay_settled_at, real_synced_at, updated_at
       FROM appointments WHERE (starts_at AT TIME ZONE 'Europe/Kiev')::date = $1::date`, [DAY])).rows;
  let updAppts = 0;
  for (const a of appts) {
    const r = await live.query(
      `UPDATE appointments SET status=$2, real_amount=$3, price=COALESCE($4, price),
              pay_settled_at=COALESCE($5, pay_settled_at), real_synced_at=COALESCE($6, real_synced_at), updated_at=NOW()
        WHERE id=$1 AND status IN ('booked','confirmed') AND $2 NOT IN ('booked')`,
      [a.id, a.status, a.real_amount, a.price, a.pay_settled_at, a.real_synced_at]).catch(() => ({ rowCount: 0 }));
    if (r.rowCount) updAppts++;
  }

  // 3) строки услуг визитов дня
  const rows = (await pri.query(
    `SELECT asv.* FROM appointment_services asv JOIN appointments a ON a.id=asv.appointment_id
      WHERE (a.starts_at AT TIME ZONE 'Europe/Kiev')::date = $1::date`, [DAY])).rows;
  let insSvc = 0;
  for (const s of rows) {
    const cols = Object.keys(s);
    const r = await live.query(
      `INSERT INTO appointment_services (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
       ON CONFLICT (id) DO NOTHING`, cols.map(c => s[c])).catch(() => ({ rowCount: 0 }));
    if (r.rowCount) insSvc++;
  }
  await live.query(`SELECT setval('appointment_services_id_seq', GREATEST((SELECT MAX(id) FROM appointment_services), 1), true)`).catch(() => {});

  const sum = (await live.query(
    `SELECT ROUND(COALESCE(SUM(amount),0),2) s FROM cash_operations
      WHERE type='in' AND category IN ('sale_service','sale_product')
        AND (created_at AT TIME ZONE 'Europe/Kiev')::date = $1::date`, [DAY])).rows[0].s;
  console.log(`RECOVERED day=${DAY}: cash+${insOps} appts~${updAppts} svc+${insSvc} | касса дня теперь: ${sum} грн`);
  await pri.end(); await live.end();
  process.exit(0);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
