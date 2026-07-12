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
const { getPool, applyTenant } = require('../db-pg');
const slotEngine = require('./../lib/slot-engine');
const bookingBot = require('../lib/booking-bot');
const { t, validateBody } = require('../lib/validate');
const { normalizePhoneDb } = require('../lib/phone');

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
// SAS этап 1: личные боты салонов (tenant_bot_settings) + tenant-контекст вебхука
const { resolveBySlug, runAs } = require('../lib/tenant');
const { getBotForTenant, listConnectedBots } = require('../lib/tenant-bots');
const { isLicensed } = require('../lib/license-check');
const { DEFAULT_TENANT_ID } = require('../lib/tenant');

// === Helpers ============================================
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Резолв id онлайн-записи (BeautyPro GUID / 'svc-N'/'mst-N' / наш numeric) → внутренние
// masters.id, services.id + цена/длительность. Нужен чтобы писать запись в НАШУ таблицу
// appointments (журнал мастера) без BeautyPro. Урок 02.07 — самостоятельность от BP.
async function resolveBookingIds(pool, serviceRef, masterRef) {
  const digits = (s) => String(s || '').replace(/^svc-|^mst-/, '');
  const svcRef = digits(serviceRef), mstRef = digits(masterRef);
  const svc = await pool.query(
    `SELECT id, price, COALESCE(duration_min, 60) AS dur FROM services
      WHERE beautypro_id::text = $1 OR id::text = $1 LIMIT 1`, [svcRef]).catch(() => ({ rows: [] }));
  const mst = await pool.query(
    `SELECT id FROM masters WHERE beautypro_id::text = $1 OR id::text = $1 LIMIT 1`, [mstRef])
    .catch(() => ({ rows: [] }));
  return {
    serviceId: svc.rows[0]?.id || null,
    masterId: mst.rows[0]?.id || null,
    price: svc.rows[0]?.price ?? null,
  };
}

// Сирий виклик Telegram API (одна спроба).
function tgRaw(method, body, botToken = BOT_TOKEN) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 12000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('telegram timeout')));
    req.write(data);
    req.end();
  });
}

// Надійна відправка: НЕ втрачає відповідь мовчки.
// - 429 (rate limit) → чекаємо retry_after і повторюємо (це і була «тиша» на частих повідомленнях);
// - мережева помилка/5xx → короткий retry;
// - інші відмови Telegram (400 тощо) → логуємо, щоб було видно, а не глухо.
async function tg(method, body, _try = 0, botToken = BOT_TOKEN) {
  try {
    const r = await tgRaw(method, body, botToken);
    if (r && r.ok === false) {
      if (r.error_code === 429 && _try < 4) {
        const wait = ((r.parameters && r.parameters.retry_after) || 1) * 1000 + 150;
        await new Promise((s) => setTimeout(s, wait));
        return tg(method, body, _try + 1, botToken);
      }
      if (r.error_code >= 500 && _try < 3) {
        await new Promise((s) => setTimeout(s, 400 * (_try + 1)));
        return tg(method, body, _try + 1, botToken);
      }
      console.error(`[booking/tg] Telegram ${method} відхилив: ${r.error_code} ${r.description || ''}`);
    }
    return r;
  } catch (e) {
    if (_try < 3) {
      await new Promise((s) => setTimeout(s, 400 * (_try + 1)));
      return tg(method, body, _try + 1, botToken);
    }
    console.error(`[booking/tg] ${method} не доставлено:`, e.message);
    return { ok: false, error: e.message };
  }
}

// tg-функция, привязанная к чужому боту (SAS: ответы ботом салона-клиента)
function tgFor(botToken) {
  return (method, body) => tg(method, body, 0, botToken);
}

// Нагадування про візити 24г/2г з кнопками «Буду/Перенести/Скасувати» (Етап 5).
// Дедуп усередині (booking_reminders) — безпечно навіть якщо процесів два.
if (BOT_TOKEN) {
  try {
    require('../lib/booking-reminders').start(getPool, tg, {
      runAs, defaultTenantId: DEFAULT_TENANT_ID, tgFor, listConnectedBots,
    });
  } catch (e) { console.error('[booking/reminders-init]', e.message); }
}

// In-memory schema — no init needed

// Зсув Києва (хв) для конкретного інстанту — з урахуванням літнього/зимового часу.
function _kyivOffsetMin(utcMs) {
  const s = new Date(utcMs).toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const asIfUtc = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] === 24 ? 0 : +m[4], +m[5], +m[6]);
  return Math.round((asIfUtc - utcMs) / 60000);
}
// Наївний київський час "YYYY-MM-DDTHH:MM(:SS)" → коректний UTC-ISO. Рядки з зоною не чіпаємо.
function kyivWallToIso(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return s;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6] || 0);
  return new Date(guess - _kyivOffsetMin(guess) * 60000).toISOString();
}

// === POST /init =========================================
router.post('/init', validateBody({
  service_id: t.string({ min: 1, max: 64, required: true }),
  employee_id: t.string({ min: 1, max: 64, required: true }),
  date_from: t.string({ min: 1, max: 40, required: true }),
  date_to: t.string({ min: 1, max: 40, required: true }),
  client_name: t.string({ min: 1, max: 200, required: false }),
  channel: t.string({ min: 1, max: 40, required: false }),
}), async (req, res) => {
  try {
    const { service_id, employee_id, date_from, date_to, client_name, channel } = req.body;
    if (!service_id || !employee_id || !date_from || !date_to) {
      return res.status(400).json({ error: 'service_id, employee_id, date_from, date_to обовʼязкові' });
    }
    // ТАЙМЗОНА (аудит 07.07): /slots віддає НАЇВНИЙ київський час ("YYYY-MM-DDTHH:MM:SS" без зони).
    // Якщо зберегти сиру рядок у timestamptz (сесія БД в UTC) — візит зсунеться на 2-3 год.
    // Приводимо наївний київський час до правильного інстанту. Рядки з зоною (Z/±hh:mm) не чіпаємо.
    const dfrom = kyivWallToIso(date_from), dto = kyivWallToIso(date_to);
    // валидация дат: не в прошлом, конец после начала, не дальше года вперёд
    const from = new Date(dfrom), to = new Date(dto);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Невірний формат дати' });
    if (to <= from) return res.status(400).json({ error: 'date_to має бути пізніше date_from' });
    if (from < new Date(Date.now() - 5 * 60 * 1000)) return res.status(400).json({ error: 'Не можна записатись у минуле' });
    if (from > new Date(Date.now() + 366 * 24 * 3600 * 1000)) return res.status(400).json({ error: 'Дата занадто далеко' });
    // SAS: онлайн-запис — ліцензований модуль (салон платформи — без обмежень)
    if (!(await isLicensed(req.tenant_id, 'online_booking'))) {
      return res.status(403).json({ error: 'Онлайн-запис не активовано для цього салону. Активуйте модуль у CRM (Ліцензії та модулі).' });
    }
    const token = genToken();
    await db.insert(token, { service_id, employee_id, date_from: dfrom, date_to: dto, client_name: client_name || null, channel: channel || 'site_salon' });

    // SAS: диплинк ведёт в бота ЭТОГО салона (env-бот — только для салона Босса).
    // Чужой салон БЕЗ своего бота: ссылка на бота платформы бессмысленна —
    // тот работает в контексте салона Босса и записи этого салона не увидит.
    let botUsername = BOT_USERNAME;
    try {
      const tbot = await getBotForTenant(req.tenant_id);
      if (tbot && tbot.username) botUsername = tbot.username;
      if (req.tenant_id !== DEFAULT_TENANT_ID && (!tbot || tbot.source !== 'db')) {
        return res.status(409).json({ error: 'Підключіть Telegram-бота салону: CRM → «ТГ-бот запису». Після цього клієнти зможуть підтверджувати онлайн-запис.' });
      }
    } catch (_e) { /* fallback на бота платформи */ }
    res.json({
      ok: true,
      token,
      deep_link: `https://t.me/${botUsername}?start=${token}`,
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

// === Обробка Telegram-апдейта =============================
// Спільна для легасі-вебхука (бот Босса, env-токен) і per-tenant вебхуків
// (боти салонів-клієнтів). Параметр tg ЗАТІНЯЄ модульний tg — увесь код
// нижче автоматично відповідає правильним ботом.
async function processUpdate(upd, tg, salon) {
  {
    // tenantId для гілки власника: per-tenant вебхук іде в runAs(t.id) → getTenantId()
    // повертає салон; легасі-бот Босса без контексту → DEFAULT_TENANT_ID.
    const tenantId = require('../lib/tenant').getTenantId() || DEFAULT_TENANT_ID;
    const botCtx = { tg, pool: getPool(), bp, tenantId, salonName: (salon && salon.name) || null };

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
      // короткі deep-link ключі з сайту/візитки — це НЕ токен запису, а звичайний старт
      if (!token || /^(link|book|site|web|start|zapis|menu)$/i.test(token)) {
        // Власник салону → його меню керування (ізольовано; клієнт цього не бачить).
        try { if (await bookingBot.tryOwnerStart(msg, botCtx)) return; } catch (e) { console.error('[booking/owner-start]', e.message); }
        // Холодний старт. Якщо вже знаємо цей Telegram — вітаємо на імʼя, номер не питаємо.
        try {
          const known = await getPool().query(
            `SELECT name, tg_first_name FROM clients WHERE telegram_id = $1 LIMIT 1`,
            [msg.from.id]
          );
          if (known.rowCount) {
            const nm = known.rows[0].name || known.rows[0].tg_first_name || '';
            // привітання з кнопкою «⚡ як минулого разу» (якщо є історія візитів)
            return bookingBot.onStartKnown(msg, botCtx, nm);
          }
        } catch (e) { console.error('[booking/cold-start]', e.message); }
        // Новий користувач → пропонуємо підвʼязати номер
        return tg('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Вітаємо у ' + ((salon && salon.name) || 'SVS Beauty Space') + '! 👋\nЩоб отримувати нагадування про візити, персональні пропозиції та підтверджувати онлайн-записи — підвʼяжіть свій номер телефону одним дотиком:',
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
        // СПІВРОБІТНИК/ВЛАСНИК: номер збігається з обліковкою CRM цього салону →
        // привʼязуємо telegram_id до users (безпечно: Telegram гарантує, що контакт
        // належить відправнику — перевірка user_id вище; чужий telegram не перетремо).
        try {
          const staff = await getPool().query(
            `UPDATE users u SET telegram_id = $1, updated_at = NOW()
               FROM roles r
              WHERE r.id = u.role_id AND u.tenant_id = $3
                AND regexp_replace(COALESCE(u.phone,''), '\\D', '', 'g') = $2
                AND COALESCE(u.is_active, true) = true
                AND (u.telegram_id IS NULL OR u.telegram_id = $1)
              RETURNING u.display_name,
                (r.code = 'owner' OR r.name ILIKE '%власн%' OR r.name ILIKE '%owner%' OR r.permissions::jsonb ? '*') AS is_owner`,
            [msg.from.id, phoneDigits, tenantId]);
          if (staff.rowCount) {
            const s = staff.rows[0];
            if (s.is_owner) {
              return tg('sendMessage', {
                chat_id: msg.chat.id, parse_mode: 'HTML',
                text: `👑 Вітаю, <b>${s.display_name || 'власник'}</b>! Telegram підвʼязано до вашого акаунта.\nТепер вам приходитиме ранковий фінзвіт, а меню керування — нижче.`,
                reply_markup: bookingBot.ownerMenu ? bookingBot.ownerMenu() : undefined,
              });
            }
            return tg('sendMessage', {
              chat_id: msg.chat.id, parse_mode: 'HTML',
              text: `✅ <b>${s.display_name || ''}</b>, Telegram підвʼязано до вашого робочого акаунта. Тепер сюди приходитимуть сповіщення й коди входу.`,
            });
          }
        } catch (e) { console.error('[booking/staff-link]', e.message); }
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
              reply_markup: bookingBot.mainMenu(),
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
            `INSERT INTO clients (phone, name, telegram_id, source, tg_first_name, tg_last_name, tg_username, consent_given_at, consent_source)
             VALUES ($1, $2, $3, 'bot-link', $4, $5, $6, NOW(), 'bot')
             ON CONFLICT (tenant_id, phone) DO UPDATE SET
               consent_given_at = COALESCE(clients.consent_given_at, NOW()),
               consent_source = COALESCE(clients.consent_source, 'bot'),
               telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
               name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name),
               tg_first_name = COALESCE(EXCLUDED.tg_first_name, clients.tg_first_name),
               tg_last_name  = COALESCE(EXCLUDED.tg_last_name, clients.tg_last_name),
               tg_username   = COALESCE(EXCLUDED.tg_username, clients.tg_username)`,
            [normalizePhoneDb(phoneDigits), tgFirst, msg.from.id, tgFirst, tgLast, tgUser]
          );
          return tg('sendMessage', {
            chat_id: msg.chat.id,
            text: '✅ Ваш номер збережено та підвʼязано до Telegram. Дякуємо!',
            reply_markup: bookingBot.mainMenu(),
          });
        } catch (linkErr) {
          console.error('[booking/link]', linkErr.message);
          return tg('sendMessage', { chat_id: msg.chat.id, text: '⚠️ Не вдалось підвʼязати номер зараз. Спробуйте трохи пізніше.' });
        }
      }

      // чёрный список (#30): забаненный по телефону клиент не должен записаться.
      // Сравниваем по нормализованным цифрам — в blacklist встречаются и '+380...' и '380...'.
      try {
        const bl = await getPool().query(
          `SELECT 1 FROM blacklist
            WHERE regexp_replace(client_phone, '\\D', '', 'g') = $1 LIMIT 1`,
          [phoneDigits]
        );
        if (bl.rowCount) {
          await db.update(row.token, { status: 'error', error: 'blacklisted' });
          return tg('sendMessage', {
            chat_id: msg.chat.id,
            text: '😔 На жаль, онлайн-запис для цього номера недоступний. Будь ласка, звʼяжіться з адміністратором салону.',
            reply_markup: bookingBot.mainMenu(),
          });
        }
      } catch (blErr) { console.error('[booking/blacklist]', blErr.message); }

      // дата могла стати минулою, поки клієнт ділився контактом (перевірка при /init
      // застаріла) — не створюємо бронь у минулому (аудит v8).
      if (new Date(row.date_from) < new Date(Date.now() - 5 * 60 * 1000)) {
        await db.update(row.token, { status: 'error', error: 'slot-past' }).catch(() => {});
        return tg('sendMessage', { chat_id: msg.chat.id, text: '⏰ На жаль, час цього запису вже минув. Поверніться на сайт і оберіть новий вільний слот.' });
      }

      let bookingId = null;
      try {
        // слот мог занять кто-то другой пока клиент подтверждал — проверяем пересечение
        try {
          // Число паралельних confirmed-записів мастера не має перевищувати його
          // вмістимість (max_parallel; дефолт 1). Овербукінг дозволено настройкою.
          // canon_master_id (мігр. 248): employee_id приходить як 'mst-N'/GUID —
          // порівняння masters.id = 'mst-N' кидало cast-помилку і пре-чек мовчки пропускався
          const busy = await getPool().query(
            `SELECT (SELECT count(*) FROM online_bookings
                      WHERE master_id = canon_master_id($1) AND status = 'confirmed'
                        AND date_from < $3 AND date_to > $2) AS cnt,
                    COALESCE((SELECT max_parallel FROM masters
                               WHERE id::text = canon_master_id($1)), 1) AS cap`,
            [String(row.employee_id || ''), row.date_from, row.date_to]
          );
          if (busy.rows[0] && Number(busy.rows[0].cnt) >= Number(busy.rows[0].cap)) {
            await db.update(row.token, { status: 'error', error: 'slot-taken' });
            return tg('sendMessage', { chat_id: msg.chat.id, text: '😔 На жаль, цей час щойно зайняли. Поверніться на сайт і оберіть інший слот.' });
          }
        } catch (slotErr) { console.error('[booking/slot-check]', slotErr.message); }

        // BeautyPro — НЕОБЯЗАТЕЛЬНЫЙ синк (нас могли отключить). Источник правды —
        // наша БД online_bookings ниже. BP-запись best-effort: получилось — хорошо, нет — не рушим запись.
        let bp_id = '';
        try {
          const client = await bp.createClient({ phone, name: row.client_name || msg.from.first_name });
          const appt = await bp.createAppointment({
            client_id: client.id || client.client_id,
            service_id: row.service_id,
            employee_id: row.employee_id,
            date_from: row.date_from,
            date_to: row.date_to,
          });
          bp_id = String(appt.id || appt.appointment_id || '');
        } catch (bpErr) {
          if (!/bp-disabled/.test(bpErr.message))
            console.warn('[booking/bp-optional] BeautyPro недоступен, запись только в нашей БД:', bpErr.message);
        }
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
              `INSERT INTO clients (phone, name, telegram_id, source, tg_first_name, tg_last_name, tg_username, consent_given_at, consent_source)
               VALUES ($1, $2, $3, 'bot-salon', $4, $5, $6, NOW(), 'bot')
               ON CONFLICT (tenant_id, phone) DO UPDATE SET
                 telegram_id = COALESCE(clients.telegram_id, EXCLUDED.telegram_id),
                 name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name),
                 tg_first_name = COALESCE(EXCLUDED.tg_first_name, clients.tg_first_name),
                 tg_last_name  = COALESCE(EXCLUDED.tg_last_name, clients.tg_last_name),
                 tg_username   = COALESCE(EXCLUDED.tg_username, clients.tg_username)
               RETURNING id`,
              [normalizePhoneDb(phoneDigits), row.client_name || tgFirst, msg.from.id, tgFirst, tgLast, tgUser]
            );
          }
          // РАУНД3-FIX (ghost-booking): бронь + её тень в журнале = ОДНА транзакция.
          // Раньше тень вставлялась отдельно и catch глотал ЛЮБУЮ ошибку (включая 23P01)
          // → клиент получал ✅, а в расписании мастера было пусто.
          const txc = await getPool().connect();
          try {
            await txc.query('BEGIN');
            // RLS-контекст тенанта на транзакцію: без нього бронь+тінь писались у
            // DEFAULT-тенант незалежно від салону, а resolveBookingIds бачив чужі
            // майстра/послуги (аудит v8, блокер мультитенантності). Для бота Босса
            // контекст = DEFAULT_TENANT_ID → поведінка поточного салону не змінюється.
            await applyTenant(txc);
            const ob = await txc.query(
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

            // Тень в НАШЕМ журнале appointments (самостоятельность от BeautyPro, 02.07):
            // без неё мастер не видит онлайн-запись в расписании дня.
            const ids = await resolveBookingIds(txc, row.service_id, row.employee_id);
            if (ids.masterId && ids.serviceId) {
              const dup = await txc.query(
                `SELECT 1 FROM appointments WHERE master_id=$1 AND starts_at=$2 AND client_id=$3 LIMIT 1`,
                [ids.masterId, row.date_from, cl.rows[0].id]);
              if (!dup.rowCount) {
                // Слот уже проверен триггером брони в ЭТОЙ ЖЕ транзакции под тем же замком.
                // Повторная проверка тени дала бы ложный отказ (бронь уже видна счётчику),
                // поэтому тень идёт с локальным обходом (set_config is_local=true умирает с транзакцией).
                await txc.query(`SELECT set_config('app.skip_overbook','on', true)`);
                const ap = await txc.query(
                  `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, source, notes)
                   VALUES ($1,$2,$3,$4,$5,'booked',$6,'online',$7)
                   RETURNING id`,
                  [cl.rows[0].id, ids.masterId, ids.serviceId, row.date_from, row.date_to,
                   ids.price, `Онлайн-запис #${bookingId}${bp_id ? ' / BP ' + bp_id : ''}`]);
                // РЕАЛЬНАЯ связь бронь→запись (миграция 247): для cancel-sync и анти-двойного счёта
                await txc.query(`UPDATE online_bookings SET appointment_id=$1 WHERE id=$2`,
                  [ap.rows[0].id, bookingId]);
              }
            } else {
              console.warn('[booking/appt] не резолвнулись id услуги/мастера — запись только в online_bookings (слот держит кросс-подсчёт триггера 247)');
            }
            await txc.query('COMMIT');
          } catch (exErr) {
            await txc.query('ROLLBACK').catch(() => {});
            bookingId = null;
            if (exErr.code === '23P01') {
              // слот заняли між перевіркою і вставкою (гонка двох паралельних підтверджень)
              await db.update(row.token, { status: 'error', error: 'slot-taken' }).catch(() => {});
              return tg('sendMessage', { chat_id: msg.chat.id, text: '😔 На жаль, цей час щойно зайняли. Поверніться на сайт і оберіть інший слот.' });
            }
            // НЕ глотаем: раньше отсюда ушло бы ✅ без сохранённой записи
            await db.update(row.token, { status: 'error', error: 'db-error' }).catch(() => {});
            console.error('[booking/tx]', exErr.message);
            return tg('sendMessage', { chat_id: msg.chat.id, text: '😔 Технічна помилка при збереженні запису. Спробуйте ще раз за хвилину.' });
          } finally {
            txc.release();
          }
        } catch (logErr) {
          console.error('[booking/log]', logErr.message);
        }

        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: '✅ Запис підтверджено! Чекаємо вас у салоні. До зустрічі.',
          reply_markup: bookingBot.mainMenu(),
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
  }
}

// === POST /telegram (webhook, легасі: бот Босса на env-токені) ===========
// ВАЖЛИВО: підтверджуємо Telegram ПІСЛЯ обробки (finally), а не до неї.
// Інакше рестарт/деплой посеред обробки губить повідомлення мовчки —
// бот сказав «отримав», а відповісти не встиг. При збої немає ack →
// Telegram повторить апдейт, і клієнт таки отримає відповідь.
router.post('/telegram', async (req, res) => {
  // Захист вебхука від підробних апдейтів (аудит v8, M5). Увімкнеться АВТОМАТИЧНО,
  // коли в env зʼявиться TG_WEBHOOK_SECRET і той самий secret_token буде виставлено
  // в setWebhook. Поки змінна не задана — перевірка пропускається (бот не ламається).
  if (process.env.TG_WEBHOOK_SECRET &&
      req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: 'bad-secret' });
  }
  try {
    await processUpdate(req.body, tg, { name: 'SVS Beauty Space' });
  } catch (e) {
    console.error('[booking/telegram]', e.message);
  } finally {
    if (!res.headersSent) res.json({ ok: true });
  }
});

// === POST /telegram/t/:slug (per-tenant вебхук ботів салонів, SAS) =======
// URL реєструється автоматично в /api/bot-connect (setWebhook + secret).
router.post('/telegram/t/:slug', async (req, res) => {
  try {
    const t = await resolveBySlug(String(req.params.slug || ''));
    if (!t || t.status !== 'active') { res.status(404).json({ ok: false }); return; }
    const bot = await runAs(t.id, () => getBotForTenant(t.id));
    if (!bot || bot.source !== 'db') { res.status(404).json({ ok: false }); return; }
    // захист від підробки: Telegram шле секрет, заданий при setWebhook
    if (bot.secret && req.headers['x-telegram-bot-api-secret-token'] !== bot.secret) {
      res.status(403).json({ ok: false }); return;
    }
    // SAS: ліцензія модуля онлайн-запису (грейс 3 дні всередині isLicensed)
    if (!(await isLicensed(t.id, 'online_booking'))) {
      const chatId = req.body && ((req.body.message && req.body.message.chat && req.body.message.chat.id)
        || (req.body.callback_query && req.body.callback_query.message && req.body.callback_query.message.chat && req.body.callback_query.message.chat.id));
      if (chatId) {
        await tg('sendMessage', { chat_id: chatId, text: '⏸ Онлайн-запис тимчасово недоступний — зверніться до салону.' }, 0, bot.token).catch(() => {});
      }
      return;
    }
    // /owner <код> — привʼязка чату ВЛАСНИКА салону (зведення/алерти в його бот)
    const _msg = req.body && req.body.message;
    if (_msg && _msg.text && /^\/owner\b/.test(_msg.text.trim())) {
      await runAs(t.id, async () => {
        const { getSetting, setSetting } = require('../lib/settings');
        const code = (_msg.text.trim().split(/\s+/)[1] || '').trim();
        const saved = await getSetting('owner_link_code', null);
        let reply;
        if (saved && saved.code && code === String(saved.code) && Date.now() < Number(saved.exp || 0)) {
          await getPool().query(
            `UPDATE tenant_bot_settings SET owner_chat_id=$1, updated_at=NOW() WHERE tenant_id=$2`,
            [_msg.chat.id, t.id]);
          await setSetting('owner_link_code', null, null);
          reply = '✅ Готово! Сюди приходитимуть щоденні фінансові зведення вашого салону.';
        } else {
          reply = '❌ Код невірний або протермінований. Отримайте новий в адмінці: Налаштування → Telegram-бот.';
        }
        await tg('sendMessage', { chat_id: _msg.chat.id, text: reply }, 0, bot.token).catch(() => {});
      });
      return;
    }
    await runAs(t.id, () => processUpdate(req.body, tgFor(bot.token), { name: bot.salonName }));
  } catch (e) {
    console.error('[booking/telegram-t]', e.message);
  } finally {
    if (!res.headersSent) res.json({ ok: true });
  }
});

// === Catalog endpoints ==================================
// Ошибки апстрима BeautyPro (401 без ключа, 5xx, таймаут) НЕ протекают клиенту:
// логируем полностью, наружу — аккуратный 503 без внутренних деталей (фикс 02.07).
function upstreamFail(res, e, where) {
  console.error(`[booking:${where}]`, e.message);
  res.status(503).json({ error: 'Сервіс онлайн-запису тимчасово недоступний. Спробуйте пізніше або зателефонуйте в салон.' });
}
// GUID-совместимый id как в /catalog: beautypro_id или 'svc-'/'mst-'+id
const catId = (pref) => `COALESCE(beautypro_id::text, '${pref}-'||id)`;

// Услуги из НАШЕЙ БД (BeautyPro отвязан 03.07). Формат совместим с book.html.
router.get('/services', async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT ${catId('svc')} AS id, name, duration_min AS duration,
              price::float AS price, category
         FROM services WHERE active IS NOT FALSE AND deleted_at IS NULL
        ORDER BY sort_order NULLS LAST, name`);
    res.json(r.rows);
  } catch (e) { upstreamFail(res, e, 'services'); }
});

// Мастера из НАШЕЙ БД с их услугами (book.html оставляет только тех, у кого services.length)
router.get('/masters', async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT ${catId('mst')} AS id,
              COALESCE(NULLIF(online_title,''), name) AS name, specialty,
              COALESCE((
                SELECT json_agg(COALESCE(s.beautypro_id::text, 'svc-'||s.id))
                  FROM services s JOIN master_services ms ON ms.service_id = s.id
                 WHERE ms.master_id = m.id AND ms.active IS NOT FALSE
                   AND s.active IS NOT FALSE AND s.deleted_at IS NULL
              ), '[]'::json) AS services
         FROM masters m
        WHERE m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE
          AND m.provides_services IS NOT FALSE
        ORDER BY m.online_rank NULLS LAST, m.name`);
    res.json(r.rows);
  } catch (e) { upstreamFail(res, e, 'masters'); }
});

// Свободные слоты из НАШЕГО движка (lib/slot-engine) вместо BeautyPro.
router.get('/slots', async (req, res) => {
  try {
    const { service_id, date, duration, professional } = req.query;
    if (!date) return res.json([]);
    const pool = getPool();

    // мастера: конкретный выбранный ИЛИ все, кто оказывает услугу
    const mGid = `COALESCE(m.beautypro_id::text, 'mst-'||m.id)`;
    let masters;
    if (professional) {
      masters = (await pool.query(
        `SELECT m.id, ${mGid} AS gid FROM masters m
          WHERE (m.beautypro_id::text = $1 OR ('mst-'||m.id) = $1 OR m.id::text = $1)
            AND m.online_booking_enabled IS NOT FALSE`, [professional])).rows;
    } else if (service_id) {
      masters = (await pool.query(
        `SELECT DISTINCT m.id, ${mGid} AS gid
           FROM masters m JOIN master_services ms ON ms.master_id = m.id
           JOIN services s ON s.id = ms.service_id
          WHERE (s.beautypro_id::text = $1 OR ('svc-'||s.id) = $1 OR s.id::text = $1)
            AND ms.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE
            AND m.provides_services IS NOT FALSE`, [service_id])).rows;
    } else {
      masters = (await pool.query(
        `SELECT m.id, ${mGid} AS gid FROM masters m
          WHERE m.online_booking_enabled IS NOT FALSE AND m.provides_services IS NOT FALSE`)).rows;
    }
    if (!masters.length) return res.json([]);

    const gidBy = new Map(masters.map(m => [Number(m.id), m.gid]));
    const durationMin = Math.max(15, parseInt(duration, 10) || 60);
    const slots = await slotEngine.freeSlotsForDate(pool, {
      date, masterIds: masters.map(m => Number(m.id)), durationMin,
    });
    // формат, который понимает normalizeSlots в book.html: {time, from, employees:[gid]}
    res.json(slots.map(s => ({
      time: s.label,
      from: `${date}T${s.label.length === 5 ? s.label + ':00' : s.label}`,
      employees: gidBy.get(s.masterId) ? [gidBy.get(s.masterId)] : [],
    })));
  } catch (e) { upstreamFail(res, e, 'slots'); }
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
module.exports.resolveBookingIds = resolveBookingIds;
