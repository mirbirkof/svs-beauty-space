/* ═══════════════════════════════════════════════════════
   Waitlist & Unified Online Booking
   POST /api/waitlist          → встать в очередь
   GET  /api/waitlist          → admin: список pending
   GET  /api/waitlist/mine     → клиент: свои записи (по phone)
   PATCH /api/waitlist/:id     → admin: статусы / предложить слот
   GET  /api/booking/schedule  → unified расписание (через BP freeTime)
   POST /api/booking/confirm   → создать запись в BP + локальный online_bookings
   GET  /api/booking/history   → история по phone (все каналы)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool, applyTenant } = require('../db-pg');
const { resolveBookingIds } = require('./booking');
const { requirePerm } = require('../lib/rbac');
const { authClient } = require('./cabinet-auth');
const { normalizePhoneDb } = require('../lib/phone');

const pool = getPool();

// Канон БД = '380XXXXXXXXX' БЕЗ '+' (lib/phone.js, аудит #31). Локальная версия
// с '+380' плодила второй формат в waitlist/online_bookings и дубли клиентов.
// Существующие '+380...' строки waitlist приведены к канону миграцией 198.
function normalizePhone(p) {
  return normalizePhoneDb(p);
}

async function getOrCreateClient(phone, name, telegram_id) {
  const ph = normalizePhone(phone);
  if (!ph) return null;
  const phDigits = ph.replace(/\D/g, ''); // БД хранит цифры (380...) — сравниваем нормализованно
  const existing = await pool.query(
    `SELECT id FROM clients WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`, [phDigits]);
  if (existing.rows.length) {
    if (telegram_id) {
      await pool.query('UPDATE clients SET telegram_id = COALESCE(telegram_id, $1), name = COALESCE(NULLIF(name,\'\'), $2) WHERE id = $3', [telegram_id, name, existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  // ON CONFLICT: два параллельных запроса с одним телефоном не создадут дубль
  const r = await pool.query(
    `INSERT INTO clients (phone, name, telegram_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET
       telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
       name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
     RETURNING id`,
    [phDigits, name || null, telegram_id || null]
  );
  return r.rows[0].id;
}

// ════════════════════ WAITLIST ════════════════════

// POST /api/waitlist — встать в очередь
router.post('/waitlist', async (req, res) => {
  try {
    const {
      phone, name, telegram_id,
      service_id, service_name,
      master_id, master_name,
      preferred_from, preferred_to,
      channel, note,
    } = req.body;
    if (!phone || !service_id || !preferred_from || !preferred_to) {
      return res.status(400).json({ error: 'phone, service_id, preferred_from, preferred_to обовʼязкові' });
    }
    const client_id = await getOrCreateClient(phone, name, telegram_id);
    const r = await pool.query(`
      INSERT INTO waitlist
        (client_id, client_phone, client_name, service_id, service_name, master_id, master_name,
         preferred_from, preferred_to, channel, note, telegram_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
      RETURNING id, status, created_at
    `, [client_id, normalizePhone(phone), name || null, service_id, service_name || null,
        master_id || null, master_name || null, preferred_from, preferred_to,
        channel || 'site_salon', note || null, telegram_id || null]);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    console.error('[waitlist/add]', e.message);
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// GET /api/waitlist — admin
router.get('/waitlist', requirePerm('waitlist.read'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM waitlist
      WHERE status IN ('pending','offered')
      ORDER BY created_at DESC LIMIT 200
    `);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/waitlist/mine — телефон берём ТОЛЬКО из авторизованной сессии кабинета
// (раньше любой ?phone= отдавал чужую очередь → утечка PII по перебору номеров)
router.get('/waitlist/mine', authClient(), async (req, res) => {
  try {
    const phone = normalizePhone(req.client.phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const r = await pool.query(
      'SELECT * FROM waitlist WHERE client_phone = $1 ORDER BY created_at DESC LIMIT 50',
      [phone]
    );
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/waitlist/:id — admin
router.patch('/waitlist/:id', requirePerm('waitlist.write'), async (req, res) => {
  try {
    const { status, offered_slot, note } = req.body;
    const patches = [];
    const vals = [];
    let i = 1;
    if (status) { patches.push(`status = $${i++}`); vals.push(status); }
    if (offered_slot) { patches.push(`offered_slot = $${i++}, offered_at = NOW()`); vals.push(offered_slot); }
    if (note !== undefined) { patches.push(`note = $${i++}`); vals.push(note); }
    if (status === 'confirmed') patches.push('confirmed_at = NOW()');
    patches.push('updated_at = NOW()');
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE waitlist SET ${patches.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════════════════ BOOKING ════════════════════

router.get('/booking/history', authClient(), async (req, res) => {
  try {
    const phone = normalizePhone(req.client.phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const [bookings, waiting, orders] = await Promise.all([
      pool.query('SELECT * FROM online_bookings WHERE client_phone = $1 ORDER BY date_from DESC LIMIT 50', [phone]),
      pool.query('SELECT * FROM waitlist WHERE client_phone = $1 ORDER BY created_at DESC LIMIT 20', [phone]),
      pool.query('SELECT id, status, total, created_at FROM orders WHERE client_id = (SELECT id FROM clients WHERE phone = $1) ORDER BY created_at DESC LIMIT 20', [phone]),
    ]);
    res.json({
      phone,
      bookings: bookings.rows,
      waitlist: waiting.rows,
      orders: orders.rows,
    });
  } catch (e) {
    console.error('[booking/history]', e.message);
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// GET /api/booking/admin/all — admin: все online_bookings
router.get('/booking/admin/all', requirePerm('booking.read'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM online_bookings
      ORDER BY date_from DESC LIMIT 500
    `);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// /booking/services и /booking/masters ПЕРЕНЕСЕНЫ в routes/booking.js
// (там они читают из нашей БД, а не из отвязанного стара CRM). Дубли убраны 04.07,
// чтобы waitlist не перехватывал их раньше booking.js своими 503-заглушками.

module.exports = router;
