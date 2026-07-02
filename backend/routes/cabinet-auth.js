/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Cabinet Auth (Postgres)
   POST /api/cabinet/request-code  { phone }
   POST /api/cabinet/verify        { phone, code } → token
   GET  /api/cabinet/me            (Authorization: Bearer)
   PATCH /api/cabinet/me           { name, email, birthday }
   ─────────────────────────────────────────────────────────
   DEV-режим: если SMS_PROVIDER не задан — код 0000 принимается всегда.
   Прод: подключим Twilio / TurboSMS позже.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { t, validateBody } = require('../lib/validate');

const router = express.Router();
const DEV_CODE = '0000';
const TOKEN_TTL_DAYS = 30;

function normalizePhone(p) {
  // Канон БД 380XXXXXXXXX (#107): '0...', '80...', '+380...' приводим к одному виду,
  // иначе апсёрт клиента в /verify плодил карточки с телефоном «с нуля».
  const { normalizePhoneDb } = require('../lib/phone');
  return normalizePhoneDb(p) || '';
}

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// В БД храним ТОЛЬКО sha256 токена. Утечка дампа sessions не даёт рабочих токенов
// (raw token есть лишь у клиента). Совпадает с подходом user_tokens в lib/rbac.js.
function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}

// middleware: достаёт клиента из Bearer токена
function authClient({ optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        if (optional) return next();
        return res.status(401).json({ error: 'no-token' });
      }
      const pool = getPool();
      // dual-lookup: $1 = sha256 (новые/мигрированные), $2 = legacy plaintext (до миграции 137).
      // Порядок деплоя кода и миграции не важен — старые сессии не рвутся.
      const r = await pool.query(
        `SELECT s.id AS sid, s.expires_at, c.*
         FROM sessions s JOIN clients c ON c.id = s.client_id
         WHERE s.token = $1 OR s.token = $2`,
        [hashToken(token), token]
      );
      if (r.rowCount === 0 || new Date(r.rows[0].expires_at) < new Date()) {
        if (optional) return next();
        return res.status(401).json({ error: 'invalid-token' });
      }
      const row = r.rows[0];
      req.client = {
        id: row.id, phone: row.phone, name: row.name, email: row.email,
        loyalty_points: row.loyalty_points, total_spent: row.total_spent,
      };
      next();
    } catch (e) {
      console.error('[auth]', e);
      res.status(500).json({ error: 'internal' });
    }
  };
}

// ── запрос кода ─────────────────────────────────────────
// Доставка ТОЛЬКО через Telegram (бот @Svs_beautybot).
// DEV-режим (код 0000) — только при явном ALLOW_DEV_LOGIN=1 (локальная разработка).
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'Svs_beautybot';
const MAX_VERIFY_ATTEMPTS = 5;

router.post('/request-code', validateBody({
  phone: t.phone({ required: true }),
}), async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 9) return res.status(400).json({ error: 'bad-phone' });

    const pool = getPool();

    // Rate limit: не больше 3 кодов в минуту на телефон
    const recent = await pool.query(
      `SELECT COUNT(*) FROM sms_codes WHERE phone = $1 AND created_at > NOW() - INTERVAL '60 seconds'`,
      [phone]
    ).catch(() => null);
    if (recent && Number(recent.rows[0].count) >= 3) {
      return res.status(429).json({ error: 'too-many-requests', retry_after_seconds: 60 });
    }

    const expires = new Date(Date.now() + 5 * 60 * 1000);

    // DEV-режим: только по явному флагу, НИКОГДА в проде
    if (process.env.ALLOW_DEV_LOGIN === '1') {
      await pool.query(
        `INSERT INTO sms_codes (phone, code, expires_at, used) VALUES ($1,$2,$3,false)`,
        [phone, DEV_CODE, expires]
      );
      return res.json({ ok: true, mode: 'dev', hint: `dev-code: ${DEV_CODE}` });
    }

    // Ищем клиента с привязанным Telegram
    const cl = await pool.query(
      'SELECT id, telegram_id FROM clients WHERE phone LIKE $1 AND telegram_id IS NOT NULL LIMIT 1',
      ['%' + phone.slice(-10)]
    );
    if (!cl.rows[0]) {
      // Telegram не привязан — вход невозможен, объясняем как привязать
      return res.json({
        ok: true,
        mode: 'telegram-link-required',
        bot: '@' + BOT_USERNAME,
        bot_url: `https://t.me/${BOT_USERNAME}`,
        message: `Щоб увійти, відкрийте бота @${BOT_USERNAME}, натисніть «Старт» і поділіться номером телефону. Після цього запросіть код ще раз.`,
      });
    }

    // Сначала шлём код, и только при успехе сохраняем — иначе клиент без кода
    const code = genCode();
    try {
      const { tgSend } = require('./telegram-notify');
      await tgSend(String(cl.rows[0].telegram_id),
        `🔑 Ваш код для входу в кабінет: <b>${code}</b>\nДійсний 5 хвилин. Якщо це були не ви — проігноруйте.`);
    } catch (tgErr) {
      console.error('[auth:request] tg-send-failed', tgErr.message);
      return res.status(503).json({
        error: 'tg-send-failed',
        message: 'Не вдалося надіслати код у Telegram. Спробуйте пізніше.',
      });
    }

    // Инвалидируем старые активные коды и сохраняем новый
    await pool.query(`UPDATE sms_codes SET used = true WHERE phone = $1 AND used = false`, [phone]);
    await pool.query(
      `INSERT INTO sms_codes (phone, code, expires_at, used) VALUES ($1,$2,$3,false)`,
      [phone, code, expires]
    );

    res.json({ ok: true, mode: 'telegram' });
  } catch (e) {
    console.error('[auth:request]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── проверка кода → сессия ──────────────────────────────
router.post('/verify', validateBody({
  phone: t.phone({ required: true }),
  code: t.string({ min: 4, max: 8, required: true }),
}), async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone-and-code-required' });

    const pool = getPool();

    // DEV-код принимается ТОЛЬКО при явном ALLOW_DEV_LOGIN=1 (локальная разработка)
    let codeOk = false;
    if (process.env.ALLOW_DEV_LOGIN === '1' && code === DEV_CODE) {
      codeOk = true;
    } else {
      // Берём последний активный код и сверяем с защитой от перебора
      const r = await pool.query(
        `SELECT id, code, attempts FROM sms_codes
         WHERE phone=$1 AND used=false AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [phone]
      );
      if (r.rowCount > 0) {
        const row = r.rows[0];
        if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
          await pool.query(`UPDATE sms_codes SET used=true WHERE id=$1`, [row.id]);
          return res.status(401).json({ error: 'max-attempts-exceeded' });
        }
        if (row.code === code) {
          await pool.query(`UPDATE sms_codes SET used=true WHERE id=$1`, [row.id]);
          codeOk = true;
        } else {
          await pool.query(`UPDATE sms_codes SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
          return res.status(401).json({ error: 'bad-code', attempts_left: MAX_VERIFY_ATTEMPTS - row.attempts - 1 });
        }
      }
    }
    if (!codeOk) return res.status(401).json({ error: 'bad-code' });

    // апсёрт клиента
    const cl = await pool.query(
      `INSERT INTO clients (phone, source) VALUES ($1, 'cabinet')
       ON CONFLICT (tenant_id, phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, phone, name, email, loyalty_points`,
      [phone]
    );
    const client = cl.rows[0];

    const token = genToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400 * 1000);
    await pool.query(
      `INSERT INTO sessions (client_id, token, expires_at, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5)`,
      [client.id, hashToken(token), expiresAt, req.headers['user-agent'] || '', req.ip]
    );

    res.json({ ok: true, token, expires_at: expiresAt, client });
  } catch (e) {
    console.error('[auth:verify]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── профиль ─────────────────────────────────────────────
router.get('/me', authClient(), (req, res) => {
  res.json({ ok: true, client: req.client });
});

router.patch('/me', authClient(), async (req, res) => {
  try {
    const { name, email, birthday } = req.body || {};
    const pool = getPool();
    const r = await pool.query(
      `UPDATE clients
       SET name = COALESCE($2, name),
           email = COALESCE($3, email),
           birthday = COALESCE($4, birthday),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, phone, name, email, birthday, loyalty_points, total_spent`,
      [req.client.id, name || null, email || null, birthday || null]
    );
    res.json({ ok: true, client: r.rows[0] });
  } catch (e) {
    console.error('[auth:patch-me]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── logout ──────────────────────────────────────────────
router.post('/logout', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const token = (req.headers.authorization || '').slice(7);
    await pool.query(`DELETE FROM sessions WHERE token = $1 OR token = $2`, [hashToken(token), token]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth:logout]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
module.exports.authClient = authClient;
