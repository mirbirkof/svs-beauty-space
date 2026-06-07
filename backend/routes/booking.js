/* ═══════════════════════════════════════════════════════
   Booking Routes — онлайн-запись с верификацией через TG
   POST /api/booking/init        → создать pending + deep-link
   POST /api/booking/telegram    → webhook Telegram бота
   GET  /api/booking/status/:tk  → опрос с фронта (poll)
   GET  /api/booking/services    → список услуг из BeautyPro
   GET  /api/booking/masters     → мастера для услуги
   GET  /api/booking/slots       → свободные слоты
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const router = express.Router();
const bp = require('../beautyproClient');
const { Pool } = require('pg');

// Postgres pending bookings — общая БД для бота, сайта, магазина
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const db = {
  async insert(token, row) {
    await pool.query(
      `INSERT INTO booking_pending (token, service_id, employee_id, date_from, date_to, client_name, channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [token, row.service_id, row.employee_id, row.date_from, row.date_to, row.client_name || null, row.channel || 'site_salon']
    );
  },
  async get(token) {
    const r = await pool.query('SELECT * FROM booking_pending WHERE token = $1', [token]);
    return r.rows[0] || null;
  },
  async byTgUser(uid) {
    const r = await pool.query(
      `SELECT * FROM booking_pending WHERE tg_user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`, [uid]);
    return r.rows[0] || null;
  },
  async update(token, patch) {
    const cols = [];
    const vals = [];
    let i = 1;
    for (const k of Object.keys(patch)) {
      cols.push(`${k} = $${i++}`);
      vals.push(patch[k]);
    }
    if (!cols.length) return;
    vals.push(token);
    await pool.query(`UPDATE booking_pending SET ${cols.join(', ')} WHERE token = $${i}`, vals);
  },
};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'Svs_beautybot';

// === Helpers ============================================
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function tg(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// In-memory schema — no init needed

// === POST /init =========================================
router.post('/init', async (req, res) => {
  try {
    const { service_id, employee_id, date_from, date_to, client_name, channel } = req.body;
    if (!service_id || !employee_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'service_id, employee_id, date_from, date_to обовʼязкові' });
    }
    const token = genToken();
    await db.insert(token, { service_id, employee_id, date_from, date_to, client_name: client_name || null, channel: channel || 'site_salon' });

    res.json({
      ok: true,
      token,
      deep_link: `https://t.me/${BOT_USERNAME}?start=${token}`,
    });
  } catch (e) {
    console.error('[booking/init]', e.message);
    res.status(500).json({ error: 'Не вдалось ініціалізувати запис' });
  }
});

// === GET /status/:token =================================
router.get('/status/:token', async (req, res) => {
  const row = await db.get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ status: row.status, appointment_id: row.appointment_id || null, error: row.error || null });
});

// === POST /telegram (webhook) ===========================
router.post('/telegram', async (req, res) => {
  res.json({ ok: true }); // ack immediately
  try {
    const upd = req.body;
    const msg = upd.message;
    if (!msg) return;

    // /start <token>
    if (msg.text && msg.text.startsWith('/start')) {
      const parts = msg.text.split(' ');
      const token = parts[1];
      if (!token) {
        return tg('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Вітаємо! Цей бот підтверджує онлайн-записи на сайті SVS Beauty Space. Перейдіть на сайт щоб почати.',
        });
      }
      const row = await db.get(token);
      if (!row) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '⌛ Запис застарів. Поверніться на сайт і почніть знову.' });
      }
      if (row.status !== 'pending') {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '✓ Цей запис вже підтверджено.' });
      }
      // store tg_user_id, ask contact
      await db.update(token, { tg_user_id: msg.from.id });
      return tg('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Для підтвердження запису поділіться номером телефону:',
        reply_markup: {
          keyboard: [[{ text: '📱 Поділитись номером', request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
    }

    // contact received
    if (msg.contact) {
      // critical: contact must belong to sender
      if (msg.contact.user_id !== msg.from.id) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '❌ Можна поділитись лише власним номером.' });
      }
      const phone = '+' + msg.contact.phone_number.replace(/\D/g, '');
      const row = await db.byTgUser(msg.from.id);
      if (!row) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: 'Активних записів немає.' });
      }

      try {
        const client = await bp.createClient({ phone, name: row.client_name || msg.from.first_name });
        const appt = await bp.createAppointment({
          client_id: client.id || client.client_id,
          service_id: row.service_id,
          employee_id: row.employee_id,
          date_from: row.date_from,
          date_to: row.date_to,
        });
        const bp_id = String(appt.id || appt.appointment_id || '');
        await db.update(row.token, { status: 'confirmed', phone, appointment_id: bp_id, verified_at: new Date().toISOString() });

        // Запись в общий журнал online_bookings — для unified history по телефону
        try {
          // upsert клиента
          const cl = await pool.query(
            `INSERT INTO clients (phone, name, telegram_id, source)
             VALUES ($1, $2, $3, 'bot-salon')
             ON CONFLICT (phone) DO UPDATE SET
               telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
               name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
             RETURNING id`,
            [phone, row.client_name || msg.from.first_name || null, msg.from.id]
          );
          await pool.query(
            `INSERT INTO online_bookings
              (client_id, client_phone, client_name, service_id, master_id,
               date_from, date_to, channel, bp_appointment_id, status,
               source_token, telegram_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11)`,
            [cl.rows[0].id, phone, row.client_name || msg.from.first_name || null,
             row.service_id, row.employee_id, row.date_from, row.date_to,
             row.channel || 'bot', bp_id, row.token, msg.from.id]
          );
        } catch (logErr) {
          console.error('[booking/log]', logErr.message);
        }

        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: '✅ Запис підтверджено! Чекаємо вас у салоні. До зустрічі.',
          reply_markup: { remove_keyboard: true },
        });
      } catch (e) {
        console.error('[booking/bp-push]', e.message);
        await db.update(row.token, { status: 'failed', error: e.message.slice(0, 200) });
        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: '⚠️ Не вдалось зберегти запис у CRM. Адміністратор звʼяжеться з вами найближчим часом.',
        });
      }
    }
  } catch (e) {
    console.error('[booking/telegram]', e.message);
  }
});

// === Catalog endpoints ==================================
router.get('/services', async (req, res) => {
  try { res.json(await bp.listServices()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/masters', async (req, res) => {
  try { res.json(await bp.listEmployees()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/slots', async (req, res) => {
  try {
    const { duration, professional, from, to } = req.query;
    res.json(await bp.freeTime({ duration, professional, from, to }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
