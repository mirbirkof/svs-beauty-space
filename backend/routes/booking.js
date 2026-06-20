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
const bookingBot = require('../lib/booking-bot');

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

// In-memory schema — no init needed

// === POST /init =========================================
router.post('/init', async (req, res) => {
  try {
    const { service_id, employee_id, date_from, date_to, client_name, channel } = req.body;
    if (!service_id || !employee_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'service_id, employee_id, date_from, date_to обовʼязкові' });
    }
    // валидация дат: не в прошлом, конец после начала, не дальше года вперёд
    const from = new Date(date_from), to = new Date(date_to);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Невірний формат дати' });
    if (to <= from) return res.status(400).json({ error: 'date_to має бути пізніше date_from' });
    if (from < new Date(Date.now() - 5 * 60 * 1000)) return res.status(400).json({ error: 'Не можна записатись у минуле' });
    if (from > new Date(Date.now() + 366 * 24 * 3600 * 1000)) return res.status(400).json({ error: 'Дата занадто далеко' });
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
    const botCtx = { tg, pool: getPool(), bp };

    // Розмовна запис: натискання inline-кнопок → повністю в booking-bot
    if (upd.callback_query) {
      await bookingBot.onCallback(upd.callback_query, botCtx);
      return;
    }

    const msg = upd.message;
    if (!msg) return;

    // /start <token>
    if (msg.text && msg.text.startsWith('/start')) {
      const parts = msg.text.split(' ');
      const token = parts[1];
      if (!token || token === 'link') {
        // Холодний старт. Якщо вже знаємо цей Telegram — вітаємо на імʼя, номер не питаємо.
        try {
          const known = await getPool().query(
            `SELECT name, tg_first_name FROM clients WHERE telegram_id = $1 LIMIT 1`,
            [msg.from.id]
          );
          if (known.rowCount) {
            const nm = known.rows[0].name || known.rows[0].tg_first_name || '';
            return tg('sendMessage', {
              chat_id: msg.chat.id,
              text: `З поверненням${nm ? ', ' + nm : ''}! 👋\nЩоб записатись — просто напишіть послугу (напр. «манікюр», «стрижка і фарбування»), і я підберу час.`,
              reply_markup: { remove_keyboard: true },
            });
          }
        } catch (e) { console.error('[booking/cold-start]', e.message); }
        // Новий користувач → пропонуємо підвʼязати номер
        return tg('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Вітаємо у SVS Beauty Space! 👋\nЩоб отримувати нагадування про візити, персональні пропозиції та підтверджувати онлайн-записи — підвʼяжіть свій номер телефону одним дотиком:',
          reply_markup: {
            keyboard: [[{ text: '📱 Поділитись номером', request_contact: true }]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
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

    // Вільний текст (не команда) → розмовна онлайн-запис: пишемо послугу, бот веде до запису
    if (msg.text && !msg.text.startsWith('/')) {
      await bookingBot.onText(msg, botCtx);
      return;
    }

    // contact received
    if (msg.contact) {
      // critical: contact must belong to sender
      if (msg.contact.user_id !== msg.from.id) {
        return tg('sendMessage', { chat_id: msg.chat.id, text: '❌ Можна поділитись лише власним номером.' });
      }
      const phoneDigits = msg.contact.phone_number.replace(/\D/g, ''); // локальная БД хранит цифры (380...)
      const phone = '+' + phoneDigits; // для BeautyPro — с плюсом
      // повний профіль Telegram (зберігаємо один раз, щоб упізнавати клієнта)
      const tgFirst = msg.contact.first_name || msg.from.first_name || null;
      const tgLast  = msg.contact.last_name  || msg.from.last_name  || null;
      const tgUser  = msg.from.username || null;
      const row = await db.byTgUser(msg.from.id);
      if (!row) {
        // Розмовна запис чекає номер для завершення? → бронюємо й виходимо.
        if (await bookingBot.onContact(msg, botCtx)) return;
        // Немає активного запису → режим привʼязки акаунта до клієнта за номером.
        // Telegram гарантує що номер належить відправнику (перевірка user_id вище).
        try {
          const upd2 = await getPool().query(
            `UPDATE clients SET telegram_id = $1,
               name = COALESCE(NULLIF(name,''), $3),
               tg_first_name = COALESCE($4, tg_first_name),
               tg_last_name  = COALESCE($5, tg_last_name),
               tg_username   = COALESCE($6, tg_username)
             WHERE regexp_replace(phone, '\\D', '', 'g') = $2
               AND (telegram_id IS NULL OR telegram_id = $1)
             RETURNING id, name`,
            [msg.from.id, phoneDigits, tgFirst, tgFirst, tgLast, tgUser]
          );
          if (upd2.rowCount) {
            return tg('sendMessage', {
              chat_id: msg.chat.id,
              text: `✅ Готово${upd2.rows[0].name ? ', ' + upd2.rows[0].name : ''}! Ваш Telegram підвʼязано.\nЩоб записатись — просто напишіть послугу (напр. «манікюр»), і я підберу вільний час.`,
              reply_markup: { remove_keyboard: true },
            });
          }
          // номер є в базі, але вже зайнятий іншим Telegram-акаунтом
          const exists = await getPool().query(
            `SELECT telegram_id FROM clients WHERE regexp_replace(phone,'\\D','','g') = $1 LIMIT 1`,
            [phoneDigits]
          );
          if (exists.rowCount && exists.rows[0].telegram_id && String(exists.rows[0].telegram_id) !== String(msg.from.id)) {
            return tg('sendMessage', { chat_id: msg.chat.id, text: '⚠️ Цей номер вже підвʼязано до іншого Telegram-акаунта. Якщо це помилка — звʼяжіться з адміністратором салону.' });
          }
          // номера ще немає в базі → створюємо картку клієнта
          await getPool().query(
            `INSERT INTO clients (phone, name, telegram_id, source, tg_first_name, tg_last_name, tg_username)
             VALUES ($1, $2, $3, 'bot-link', $4, $5, $6)
             ON CONFLICT (tenant_id, phone) DO UPDATE SET
               telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
               name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name),
               tg_first_name = COALESCE(EXCLUDED.tg_first_name, clients.tg_first_name),
               tg_last_name  = COALESCE(EXCLUDED.tg_last_name, clients.tg_last_name),
               tg_username   = COALESCE(EXCLUDED.tg_username, clients.tg_username)`,
            [phoneDigits, tgFirst, msg.from.id, tgFirst, tgLast, tgUser]
          );
          return tg('sendMessage', {
            chat_id: msg.chat.id,
            text: '✅ Ваш номер збережено та підвʼязано до Telegram. Дякуємо!',
            reply_markup: { remove_keyboard: true },
          });
        } catch (linkErr) {
          console.error('[booking/link]', linkErr.message);
          return tg('sendMessage', { chat_id: msg.chat.id, text: '⚠️ Не вдалось підвʼязати номер зараз. Спробуйте трохи пізніше.' });
        }
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
                 name = COALESCE(NULLIF(name,''), $3),
                 tg_first_name = COALESCE($4, tg_first_name),
                 tg_last_name  = COALESCE($5, tg_last_name),
                 tg_username   = COALESCE($6, tg_username) WHERE id = $1`,
              [cl.rows[0].id, msg.from.id, row.client_name || tgFirst, tgFirst, tgLast, tgUser]
            );
          } else {
            cl = await getPool().query(
              `INSERT INTO clients (phone, name, telegram_id, source, tg_first_name, tg_last_name, tg_username)
               VALUES ($1, $2, $3, 'bot-salon', $4, $5, $6)
               ON CONFLICT (tenant_id, phone) DO UPDATE SET
                 telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
                 name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name),
                 tg_first_name = COALESCE(EXCLUDED.tg_first_name, clients.tg_first_name),
                 tg_last_name  = COALESCE(EXCLUDED.tg_last_name, clients.tg_last_name),
                 tg_username   = COALESCE(EXCLUDED.tg_username, clients.tg_username)
               RETURNING id`,
              [phoneDigits, row.client_name || tgFirst, msg.from.id, tgFirst, tgLast, tgUser]
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
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.get('/masters', async (req, res) => {
  try { res.json(await bp.listEmployees()); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.get('/slots', async (req, res) => {
  try {
    const { duration, professional, from, to } = req.query;
    res.json(await bp.freeTime({ duration, professional, from, to }));
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// === GET /catalog — нормализованный каталог из НАШЕЙ БД ==========
// Не зависит от BeautyPro env-ключей: наша БД — синхронизированное зеркало
// каталога (beautypro_id = GUID, совместим с /init и подтверждением бота).
// Источник правды для онлайн-записи: услуги active, мастера online_booking_enabled.
router.get('/catalog', async (req, res) => {
  try {
    const svc = await getPool().query(
      `SELECT COALESCE(beautypro_id::text, 'svc-'||id) AS id,
              name, COALESCE(name_ua, name) AS name_ua,
              duration_min AS duration, price::float AS price,
              category, color, photo_urls
         FROM services
        WHERE active IS NOT FALSE AND deleted_at IS NULL
        ORDER BY sort_order NULLS LAST, name`
    );
    const mst = await getPool().query(
      `SELECT COALESCE(beautypro_id::text, 'mst-'||id) AS id,
              COALESCE(NULLIF(online_title,''), name) AS name,
              specialty, avatar, online_rank, provides_services
         FROM masters
        WHERE active IS NOT FALSE AND online_booking_enabled IS NOT FALSE
        ORDER BY online_rank NULLS LAST, name`
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      services: svc.rows,
      masters: mst.rows,
      source: 'crm-db',
    });
  } catch (e) {
    console.error('[booking/catalog]', e.message);
    res.status(500).json({ error: 'Не вдалось завантажити каталог' });
  }
});

module.exports = router;
