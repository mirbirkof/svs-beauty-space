/* ═══════════════════════════════════════════════════════
   Booking Bridge: svs-booking SQLite → shop-api Postgres
   Раз в 60с переносит подтверждённые записи из svs-booking
   в общую таблицу online_bookings (Postgres).
   Это даёт единую историю клиента по телефону:
     [магазин] + [салон бот/сайт] + [waitlist]
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();
const path = require('path');
const Database = require(path.join(process.env.HOME, 'workspace/node_modules/better-sqlite3'));
const { Pool } = require('pg');

const SQLITE_PATH = path.join(process.env.HOME, 'workspace/svs-booking/db/booking.sqlite');
const INTERVAL = parseInt(process.env.BRIDGE_INTERVAL_MS || '60000', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function normalize(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return '+' + d;
  if (d.length === 10 && d.startsWith('0')) return '+38' + d;
  if (d.length === 9) return '+380' + d;
  return '+' + d;
}

async function getClientId(phone, name) {
  const ph = normalize(phone);
  if (!ph) return null;
  const r = await pool.query(
    `INSERT INTO clients (phone, name, source)
     VALUES ($1, $2, 'bridge')
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
     RETURNING id`,
    [ph, name || null]
  );
  return r.rows[0].id;
}

async function syncOnce() {
  let db;
  try {
    db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.log('[bridge] sqlite not available:', e.message);
    return 0;
  }

  let synced = 0;
  try {
    const rows = db.prepare(`
      SELECT appointment_id, client_phone, client_name, service_id, service_name,
             master_id, master_name, start_at, duration_min, status, source, created_at
      FROM appointments_log
      WHERE status IN ('active','confirmed','completed','cancelled','rescheduled')
    `).all();

    for (const r of rows) {
      if (!r.appointment_id || !r.client_phone) continue;
      const phone = normalize(r.client_phone);
      // skip if already exists
      const ex = await pool.query(
        `SELECT id FROM online_bookings WHERE bp_appointment_id = $1`,
        [r.appointment_id]
      );
      const startMs = Date.parse(r.start_at);
      const endMs = startMs + (r.duration_min || 60) * 60000;
      const date_from = new Date(startMs).toISOString();
      const date_to = new Date(endMs).toISOString();
      const status = r.status === 'active' ? 'confirmed' : r.status;
      const channel = r.source === 'widget' ? 'site_salon' : (r.source === 'bot' ? 'bot' : (r.source || 'site_salon'));

      if (ex.rows.length) {
        // update status only
        await pool.query(
          `UPDATE online_bookings SET status = $1, updated_at = NOW() WHERE bp_appointment_id = $2 AND status != $1`,
          [status, r.appointment_id]
        );
      } else {
        const client_id = await getClientId(phone, r.client_name);
        await pool.query(
          `INSERT INTO online_bookings
            (client_id, client_phone, client_name, service_id, service_name,
             master_id, master_name, date_from, date_to, channel,
             bp_appointment_id, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT DO NOTHING`,
          [client_id, phone, r.client_name || null, r.service_id, r.service_name || null,
           r.master_id, r.master_name || null, date_from, date_to, channel,
           r.appointment_id, status, r.created_at || new Date().toISOString()]
        );
        synced++;
      }
    }
  } catch (e) {
    console.error('[bridge] err:', e.message);
  } finally {
    db.close();
  }
  return synced;
}

async function loop() {
  console.log('[booking-bridge] starting, interval =', INTERVAL, 'ms');
  while (true) {
    const n = await syncOnce();
    if (n > 0) console.log('[bridge] +' + n + ' new bookings synced at', new Date().toISOString());
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

loop().catch(e => { console.error('[bridge] fatal:', e); process.exit(1); });
