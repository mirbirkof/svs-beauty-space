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
const { getPool } = require('../db-pg');

const db = {
  async insert(token, row) {
    await getPool().query(
      `INSERT INTO booking_pending (token, service_id, employee_id, date_from, date_to, client_name, channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [token, row.service_id, row.employee_id, row.date_from, row.date_to, row.client_name || null, row.channel || 'site_salon']
    );
  },
  async get(token) {
    const r = await getPool().query('SELECT * FROM booking_pending WHERE token = $1', [token]);
    return r.rows[0] || null;
  },
  async byTgUser(uid) {
    const r = await getPool().query(
      `SELECT * FROM booking_pending WHERE tg_user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`, [uid]);
    return r.rows[0] || null;
  },
  async update(token, patch) {
    const ALLOWED = ['status', 'phone', 'appointment_id', 'error', 'client_name', 'verified_at', 'tg_user_id'];
    const cols = [];
    const vals = [];
    let i = 1;
    for (const k of Object.keys(patch)) {
      if (!ALLOWED.includes(k)) continue;
      cols.push(`${k} = $${i++}`);
      vals.push(patch[k]);
    }
    if (!cols.length) return;
    vals.push(token);
    await getPool().query(`UPDATE booking_pending SET ${cols.join(', ')} WHERE token = $${i}`, vals);
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

// Настройки бронирования (CRM-05): кэш с TTL, безопасные дефолты если таблицы ещё нет
let _bsCache = null, _bsCacheTs = 0;
async function getBookingSettings() {
  if (_bsCache && Date.now() - _bsCacheTs < 60000) return _bsCache;
  const def = { min_lead_minutes: 30, max_horizon_days: 90, slot_step_minutes: 15, prevent_double_booking: true };
  try {
    const r = await getPool().query('SELECT * FROM booking_settings WHERE id = 1');
    _bsCache = r.rows[0] || def;
  } catch (_) { _bsCache = def; }
  _bsCacheTs = Date.now();
  return _bsCache;
}

// === POST /init =========================================
router.post('/init', async (req, res) => {
  try {
    const { service_id, employee_id, date_from, date_to, client_name, channel } = req.body;
    if (!service_id || !employee_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'service_id, employee_id, date_from, date_to обовʼязкові' });
    }
    // валидация дат: не в прошлом, конец после начала, не дальше горизонта (правила из настроек)
    const s = await getBookingSettings();
    const from = new Date(date_from), to = new Date(date_to);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Невірний формат дати' });
    if (to <= from) return res.status(400).json({ error: 'date_to має бути пізніше date_from' });
    if (from < new Date(Date.now() + (s.min_lead_minutes || 0) * 60 * 1000)) {
      return res.status(400).json({ error: `Запис можливий не раніше ніж за ${s.min_lead_minutes} хв` });
    }
    if (from > new Date(Date.now() + (s.max_horizon_days || 366) * 24 * 3600 * 1000)) {
      return res.status(400).json({ error: `Запис можливий не далі ніж на ${s.max_horizon_days} днів` });
    }
    // запрет накладок: слот мастера уже занят подтверждённой/ожидающей записью
    if (s.prevent_double_booking) {
      try {
        const busy = await getPool().query(
          `SELECT 1 FROM online_bookings
           WHERE master_id = $1 AND status IN ('confirmed','working')
             AND date_from < $3 AND date_to > $2 LIMIT 1`,
          [employee_id, date_from, date_to]
        );
        if (busy.rowCount) return res.status(409).json({ error: 'Цей час вже зайнятий. Оберіть інший слот.' });
        const pend = await getPool().query(
          `SELECT 1 FROM booking_pending
           WHERE employee_id = $1 AND status = 'pending'
             AND date_from < $3 AND date_to > $2
             AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
          [employee_id, date_from, date_to]
        );
        if (pend.rowCount) return res.status(409).json({ error: 'Цей час зараз бронює інший клієнт. Спробуйте інший слот.' });
      } catch (dbErr) { console.error('[booking/init double-check]', dbErr.message); }
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
      const phoneDigits = msg.contact.phone_number.replace(/\D/g, ''); // локальная БД хранит цифры (380...)
      const phone = '+' + phoneDigits; // для BeautyPro — с плюсом
      const row = await db.byTgUser(msg.from.id);
      if (!row) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: 'Активних записів немає.' });
      }

      let bookingId = null;
      try {
        // слот мог занять кто-то другой пока клиент подтверждал — проверяем пересечение
        try {
          const busy = await getPool().query(
            `SELECT 1 FROM online_bookings
             WHERE master_id = $1 AND status = 'confirmed'
               AND date_from < $3 AND date_to > $2
             LIMIT 1`,
            [row.employee_id, row.date_from, row.date_to]
          );
          if (busy.rowCount) {
            await db.update(row.token, { status: 'error', error: 'slot-taken' });
            return tg('sendMessage', { chat_id: msg.chat.id, text: '😔 На жаль, цей час щойно зайняли. Поверніться на сайт і оберіть інший слот.' });
          }
        } catch (slotErr) { console.error('[booking/slot-check]', slotErr.message); }

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
          // upsert клиента: ищем по НОРМАЛИЗОВАННОМУ номеру (в БД встречаются и '380...' и '+380...')
          let cl = await getPool().query(
            `SELECT id FROM clients WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
            [phoneDigits]
          );
          if (cl.rows.length) {
            await getPool().query(
              `UPDATE clients SET telegram_id = COALESCE(telegram_id, $2),
                 name = COALESCE(NULLIF(name,''), $3) WHERE id = $1`,
              [cl.rows[0].id, msg.from.id, row.client_name || msg.from.first_name || null]
            );
          } else {
            cl = await getPool().query(
              `INSERT INTO clients (phone, name, telegram_id, source)
               VALUES ($1, $2, $3, 'bot-salon')
               ON CONFLICT (tenant_id, phone) DO UPDATE SET
                 telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
                 name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
               RETURNING id`,
              [phoneDigits, row.client_name || msg.from.first_name || null, msg.from.id]
            );
          }
          const ob = await getPool().query(
            `INSERT INTO online_bookings
              (client_id, client_phone, client_name, service_id, master_id,
               date_from, date_to, channel, bp_appointment_id, status,
               source_token, telegram_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11)
             RETURNING id`,
            [cl.rows[0].id, phone, row.client_name || msg.from.first_name || null,
             row.service_id, row.employee_id, row.date_from, row.date_to,
             row.channel || 'bot', bp_id, row.token, msg.from.id]
          );
          bookingId = ob.rows[0].id;
        } catch (logErr) {
          console.error('[booking/log]', logErr.message);
        }

        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: '✅ Запис підтверджено! Чекаємо вас у салоні. До зустрічі.',
          reply_markup: { remove_keyboard: true },
        });

        // предоплата через Mono — fire-and-forget, запись уже подтверждена
        if (bookingId && process.env.MONO_TOKEN) {
          const chatId = msg.chat.id;
          setImmediate(async () => {
            try {
              const monoPay = require('./payments-mono');
              const inv = await monoPay.createInvoiceForBooking(bookingId);
              if (inv && inv.pageUrl) {
                await tg('sendMessage', {
                  chat_id: chatId,
                  text: `💳 Передоплата за запис: ${inv.amount} грн\nОплатіть онлайн (картка / Apple Pay / Google Pay):`,
                  reply_markup: { inline_keyboard: [[{ text: `Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] },
                });
              }
            } catch (e) { console.error('[booking/prepay]', e.message); }
          });
        }
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

// === Booking settings (admin) ===========================
const { requirePerm } = require('../lib/rbac');

router.get('/settings', requirePerm('settings.write'), async (req, res) => {
  try { res.json({ ok: true, settings: await getBookingSettings() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', requirePerm('settings.write'), async (req, res) => {
  try {
    const b = req.body || {};
    const min_lead = Math.max(0, parseInt(b.min_lead_minutes, 10) || 0);
    const horizon = Math.min(366, Math.max(1, parseInt(b.max_horizon_days, 10) || 90));
    const step = Math.min(120, Math.max(5, parseInt(b.slot_step_minutes, 10) || 15));
    const prevent = b.prevent_double_booking !== false;
    const r = await getPool().query(
      `INSERT INTO booking_settings (id, min_lead_minutes, max_horizon_days, slot_step_minutes, prevent_double_booking, updated_at)
       VALUES (1,$1,$2,$3,$4,NOW())
       ON CONFLICT (id) DO UPDATE SET
         min_lead_minutes=$1, max_horizon_days=$2, slot_step_minutes=$3, prevent_double_booking=$4, updated_at=NOW()
       RETURNING *`,
      [min_lead, horizon, step, prevent]
    );
    _bsCache = r.rows[0]; _bsCacheTs = Date.now();
    res.json({ ok: true, settings: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
