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
const db = require('../db');
const bp = require('../beautyproClient');

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

function ensureSchema() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pending_bookings (
      token TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      client_name TEXT,
      phone TEXT,
      tg_user_id INTEGER,
      status TEXT DEFAULT 'pending',
      appointment_id TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      verified_at TEXT
    )
  `).run();
}
ensureSchema();

// === POST /init =========================================
router.post('/init', (req, res) => {
  try {
    const { service_id, employee_id, date_from, date_to, client_name } = req.body;
    if (!service_id || !employee_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'service_id, employee_id, date_from, date_to обовʼязкові' });
    }
    const token = genToken();
    db.prepare(`
      INSERT INTO pending_bookings (token, service_id, employee_id, date_from, date_to, client_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, service_id, employee_id, date_from, date_to, client_name || null);

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
router.get('/status/:token', (req, res) => {
  const row = db.prepare('SELECT status, appointment_id, error FROM pending_bookings WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
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
      const row = db.prepare('SELECT * FROM pending_bookings WHERE token = ?').get(token);
      if (!row) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '⌛ Запис застарів. Поверніться на сайт і почніть знову.' });
      }
      if (row.status !== 'pending') {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '✓ Цей запис вже підтверджено.' });
      }
      // store tg_user_id, ask contact
      db.prepare('UPDATE pending_bookings SET tg_user_id = ? WHERE token = ?').run(msg.from.id, token);
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
      const row = db.prepare('SELECT * FROM pending_bookings WHERE tg_user_id = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1').get(msg.from.id);
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
        db.prepare(`
          UPDATE pending_bookings SET status='confirmed', phone=?, appointment_id=?, verified_at=datetime('now') WHERE token=?
        `).run(phone, String(appt.id || appt.appointment_id || ''), row.token);

        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: '✅ Запис підтверджено! Чекаємо вас у салоні. До зустрічі.',
          reply_markup: { remove_keyboard: true },
        });
      } catch (e) {
        console.error('[booking/bp-push]', e.message);
        db.prepare('UPDATE pending_bookings SET status=?, error=? WHERE token=?').run('failed', e.message.slice(0, 200), row.token);
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
