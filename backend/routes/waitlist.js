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
const { getPool } = require('../db-pg');
const bp = require('../beautyproClient');
const { requirePerm } = require('../lib/rbac');
const { authClient } = require('./cabinet-auth');

const pool = getPool();

function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('380')) return '+' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.length === 9) return '+380' + digits;
  return '+' + digits;
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

// GET /api/booking/schedule?service_id=&master_id=&from=&to=
// Возвращает свободные слоты из BeautyPro
router.get('/booking/schedule', async (req, res) => {
  try {
    const { service_id, master_id, from, to, duration } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to обовʼязкові (ISO format)' });
    const dur = duration || 60;
    // BP free_time: если master_id указан и не возвращает слоты — пробуем без фильтра
    let slots = await bp.freeTime({
      duration: dur,
      professional: master_id,
      from, to,
    });
    // если пусто — пробуем без master
    if (!slots || (typeof slots === 'object' && Object.keys(slots).length === 0)) {
      slots = await bp.freeTime({ duration: dur, from, to });
    }
    res.json({ ok: true, slots });
  } catch (e) {
    console.error('[booking/schedule]', e.message);
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// POST /api/booking/confirm
// Создаёт запись в BP + локально в online_bookings
// Body: { phone, name, telegram_id, service_id, service_name, master_id, master_name, date_from, date_to, channel, note }
router.post('/booking/confirm', async (req, res) => {
  try {
    const {
      phone, name, telegram_id,
      service_id, service_name,
      master_id, master_name,
      date_from, date_to,
      channel, note, source_token,
    } = req.body;
    if (!phone || !service_id || !master_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'phone, service_id, master_id, date_from, date_to обовʼязкові' });
    }
    // валидация дат: не в прошлом, конец после начала, не дальше года
    const from = new Date(date_from), to = new Date(date_to);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Невірний формат дати' });
    if (to <= from) return res.status(400).json({ error: 'date_to має бути пізніше date_from' });
    if (from < new Date(Date.now() - 5 * 60 * 1000)) return res.status(400).json({ error: 'Не можна записатись у минуле' });
    if (from > new Date(Date.now() + 366 * 24 * 3600 * 1000)) return res.status(400).json({ error: 'Дата занадто далеко' });

    const ph = normalizePhone(phone);

    // Чорний список: якщо номер заблокований для запису — не дозволяємо бронювання.
    const blk = await pool.query(
      `SELECT reason FROM blacklist WHERE client_phone=$1 AND COALESCE(blocks_booking,true)=true LIMIT 1`, [ph]);
    if (blk.rows[0]) return res.status(403).json({ error: 'client-blocked', message: 'Запис неможливий: номер у чорному списку' + (blk.rows[0].reason ? ' (' + blk.rows[0].reason + ')' : '') });

    const client_id = await getOrCreateClient(ph, name, telegram_id);

    // слот занят подтверждённой записью? (защита от двойного бронирования)
    const busy = await pool.query(
      `SELECT 1 FROM online_bookings
       WHERE master_id = $1 AND status = 'confirmed'
         AND date_from < $3 AND date_to > $2
       LIMIT 1`,
      [master_id, date_from, date_to]
    );
    if (busy.rowCount) return res.status(409).json({ error: 'slot-taken', message: 'Цей час вже зайнято, оберіть інший' });

    // BP: ensure client + create appointment
    let bp_appointment_id = null;
    let status = 'pending';
    try {
      const bpClient = await bp.createClient({ phone: ph, name: name || 'Клієнт' });
      const appt = await bp.createAppointment({
        client_id: bpClient.id || bpClient.client_id,
        service_id, employee_id: master_id,
        date_from, date_to, note: note || `Онлайн-запис (${channel || 'site'})`,
      });
      bp_appointment_id = String(appt.id || appt.appointment_id || '');
      status = 'confirmed';
    } catch (bpErr) {
      console.error('[booking/confirm bp]', bpErr.message);
      // не падаем — сохраняем локально с статусом pending, админ обработает
    }

    const r = await pool.query(`
      INSERT INTO online_bookings
        (client_id, client_phone, client_name, service_id, service_name,
         master_id, master_name, date_from, date_to, channel,
         bp_appointment_id, status, source_token, telegram_id, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, status, bp_appointment_id
    `, [client_id, ph, name || null, service_id, service_name || null,
        master_id, master_name || null, date_from, date_to, channel || 'site_salon',
        bp_appointment_id, status, source_token || null, telegram_id || null, note || null]);

    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    console.error('[booking/confirm]', e.message);
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// GET /api/booking/history — все онлайн-записи + waitlist + покупки.
// Телефон берём ТОЛЬКО из авторизованной сессии (раньше ?phone= отдавал чужую историю без auth).
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

// Ошибку апстрима BeautyPro (401 без ключа, 5xx) НЕ отдаём клиенту — аккуратный 503 (фикс 02.07)
function bpFail(res, e, where) {
  console.error(`[booking:${where}]`, e.message);
  res.status(503).json({ error: 'Дані онлайн-запису тимчасово недоступні. Спробуйте пізніше.' });
}

// GET /api/booking/services — из BeautyPro (для UI магазина и сайта)
router.get('/booking/services', async (req, res) => {
  try {
    const data = await bp.listServices();
    const list = data.data || data.items || data;
    res.json({ items: Array.isArray(list) ? list : [], count: Array.isArray(list) ? list.length : 0 });
  } catch (e) { bpFail(res, e, 'services'); }
});

// GET /api/booking/masters
router.get('/booking/masters', async (req, res) => {
  try {
    const data = await bp.listEmployees();
    const list = data.data || data.items || data;
    res.json({ items: Array.isArray(list) ? list : [], count: Array.isArray(list) ? list.length : 0 });
  } catch (e) { bpFail(res, e, 'masters'); }
});

module.exports = router;
