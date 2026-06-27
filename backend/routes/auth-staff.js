/* ═══════════════════════════════════════════════════════
   SVS CRM — Telegram-OTP логин для сотрудников

   Replaces shared X-Admin-Token with per-user session tokens.
   Flow:
     1. Босс (admin) линкует юзера: POST /link { phone, telegram_id }
        — юзер должен предварительно нажать /start у уведомлятельного бота
     2. Сотрудник логинится: POST /request { phone }
        — backend генерирует 6-значный код, шлёт юзеру в Telegram, хранит SHA256
     3. Сотрудник вводит код: POST /verify { phone, code }
        — backend сверяет, выдаёт session token (записывает hash в user_tokens)
     4. Все последующие запросы: Authorization: Bearer <token>

   ENV reuse: TELEGRAM_NOTIFY_TOKEN, ADMIN_TOKEN (legacy linking)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { tgSend } = require('./telegram-notify');
const { hashPassword, verifyPassword } = require('../lib/auth-core');

const router = express.Router();

// Fallback URL для отправки TG через svs-booking-api (у него есть BOT_TOKEN)
// Используется если локальный TELEGRAM_NOTIFY_TOKEN отсутствует/не работает.
const BOOKING_RELAY_URL = process.env.BOOKING_RELAY_URL
  || 'https://svs-booking-api.onrender.com/api/internal/tg-send-by-phone';

// Универсальная отправка: пробуем локально, если no-bot-token → через booking-api по phone
async function sendOtpToUser({ telegram_id, phone, text }) {
  try {
    await tgSend(telegram_id, text);
    return { via: 'local' };
  } catch (e) {
    if (!/no-bot-token/.test(e.message)) throw e;
    // Локального токена нет — fallback через booking-api
    const r = await fetch(BOOKING_RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // shared-secret для booking-api релая (если задан в env обоих сервисов)
        ...(process.env.INTERNAL_RELAY_SECRET ? { 'x-internal-token': process.env.INTERNAL_RELAY_SECRET } : {}),
      },
      body: JSON.stringify({ phone, text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`relay-failed: ${j.error || r.status}`);
    return { via: 'booking-api-relay' };
  }
}

const CODE_TTL_MIN = 5;
const SESSION_TTL_DAYS = 14;
const REMEMBER_TTL_DAYS = 3650; // «запомнить навсегда» = 10 лет

// Выдать session-токен пользователю. Единая точка для OTP- и пароль-входа.
async function issueSessionToken(pool, { userId, displayName, roleId, req, ttlDays, method }) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  const ua = (req.headers['user-agent'] || '').slice(0, 80);
  await pool.query(
    `INSERT INTO user_tokens (user_id, token_hash, label, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, `${method} from ${ua}`, expiresAt]
  );
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
  await pool.query(
    `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
     VALUES ($1, $2, 'auth.login', 'user', $3, $4, $5)`,
    [userId, displayName, userId,
     (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
     JSON.stringify({ method })]
  );
  return { token, expiresAt };
}

// Резолв юзера по Bearer-токену сессии (для authed эндпоинтов кабинета).
async function userByBearer(pool, req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const tokenHash = sha256(m[1]);
  const r = await pool.query(
    `SELECT u.id, u.phone, u.display_name, u.role_id, u.password_hash, u.is_active
       FROM user_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW()) AND u.is_active = true`,
    [tokenHash]
  );
  return r.rows[0] || null;
}
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function gen6() {
  // 6-значный код, без ведущих нулей лучше избегать: используем 100000..999999
  return String(crypto.randomInt(100_000, 1_000_000));
}

function normalizePhone(p) {
  // Только цифры. Плюс, пробелы, скобки, дефисы — убираем.
  // Это нормализует "+380000000000" и "380000000000" к одному виду.
  return String(p || '').replace(/\D/g, '');
}

async function throttle(pool, key) {
  const r = await pool.query(
    `INSERT INTO staff_otp_throttle (key, attempts, window_start)
     VALUES ($1, 1, NOW())
     ON CONFLICT (key) DO UPDATE
       SET attempts = CASE
             WHEN staff_otp_throttle.window_start < NOW() - INTERVAL '${RATE_LIMIT_WINDOW_MS} milliseconds'
             THEN 1
             ELSE staff_otp_throttle.attempts + 1
           END,
           window_start = CASE
             WHEN staff_otp_throttle.window_start < NOW() - INTERVAL '${RATE_LIMIT_WINDOW_MS} milliseconds'
             THEN NOW()
             ELSE staff_otp_throttle.window_start
           END
     RETURNING attempts`,
    [key]
  );
  return r.rows[0].attempts;
}

// Admin-only: legacy ADMIN_TOKEN check (timing-safe, аудит #3)
function adminOnly(req, res, next) {
  const got = req.headers['x-admin-token'];
  const want = process.env.ADMIN_TOKEN;
  let ok = false;
  if (typeof got === 'string' && typeof want === 'string' && got.length === want.length) {
    try { ok = require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── POST /api/auth/staff/link  (admin) ───────────────────────────────
// Босс линкует Telegram chat_id к юзеру. UPSERT: если юзера с таким
// телефоном нет — СОЗДАЁТ нового с переданным display_name + role_code
// (или 'master' по умолчанию). Если есть — обновляет telegram_id.
// Юзер ДОЛЖЕН первым нажать /start у уведомлятельного бота.
router.post('/link', adminOnly, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const telegram_id = parseInt(req.body?.telegram_id, 10);
    const display_name = (req.body?.display_name || '').trim();
    const role_code = (req.body?.role_code || 'master').trim();
    if (!phone || !telegram_id) return res.status(400).json({ error: 'phone-and-telegram_id-required' });

    const pool = getPool();

    // Защита от угона: этот telegram_id уже привязан к ДРУГОМУ телефону?
    // Иначе OTP-вход по этому chat_id зашёл бы в чужой аккаунт.
    const owner = await pool.query(
      `SELECT id, phone FROM users WHERE telegram_id = $1 AND phone <> $2 LIMIT 1`,
      [telegram_id, phone]
    );
    if (owner.rowCount) {
      return res.status(409).json({
        error: 'telegram-id-taken',
        message: 'Цей Telegram вже прив\'язаний до іншого співробітника'
      });
    }

    // Сначала пытаемся обновить существующего
    let r = await pool.query(
      `UPDATE users SET telegram_id = $1, updated_at = NOW()
       WHERE regexp_replace(phone, '\\D', '', 'g') = $2 RETURNING id, display_name, role_id, false AS created`,
      [telegram_id, phone]
    );

    // Если нет — создаём
    if (!r.rowCount) {
      if (!display_name) return res.status(400).json({
        error: 'display_name-required-for-new-user',
        hint: 'Користувача з таким телефоном не знайдено — для створення передайте display_name та опціонально role_code (default: master)'
      });
      const role = await pool.query(`SELECT id FROM roles WHERE code = $1`, [role_code]);
      if (!role.rowCount) return res.status(400).json({ error: 'bad-role-code', hint: 'owner|admin|manager|master|reception|readonly' });

      r = await pool.query(
        `INSERT INTO users (phone, display_name, role_id, telegram_id, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, display_name, role_id, true AS created`,
        [phone, display_name, role.rows[0].id, telegram_id]
      );

      // Логируем создание
      await pool.query(
        `INSERT INTO audit_log (user_label, action, entity, entity_id, meta)
         VALUES ($1, 'user.create', 'user', $2, $3)`,
        ['admin (link)', r.rows[0].id, JSON.stringify({ phone, display_name, role_code, via: 'auth-staff/link' })]
      );
    }

    // Шлём подтверждение в Telegram чтобы убедиться что chat_id живой
    try {
      await tgSend(telegram_id,
        `<b>Telegram прив'язано до акаунту SVS CRM</b>\n` +
        `Ласкаво просимо, ${r.rows[0].display_name}!\n\n` +
        `Тепер ви можете логінитися через OTP-код:\n` +
        `<a href="https://svs-shop-api.onrender.com/admin/login.html">Відкрити сторінку входу</a>\n\n` +
        `Введіть телефон <code>${phone}</code> — код прийде сюди.`
      );
    } catch (e) {
      // chat_id неверный или юзер не начал диалог
      return res.status(400).json({
        error: 'telegram-send-failed',
        detail: e.message,
        hint: 'Користувача створено/оновлено, але повідомлення не дійшло. Попросіть його написати боту /start',
        user: r.rows[0]
      });
    }

    res.json({ ok: true, user: r.rows[0], created: r.rows[0].created });
  } catch (e) {
    console.error('[auth-staff:link]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

// ── POST /api/auth/staff/request ─────────────────────────────────────
// Сотрудник просит OTP-код. Шлём 6-значный код в Telegram.
router.post('/request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'phone-required' });

    const pool = getPool();
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // Rate limit: не больше 3 запросов в минуту на один phone и на один ip
    const phoneAttempts = await throttle(pool, `phone:${phone}`);
    const ipAttempts = await throttle(pool, `ip:${ip || 'unknown'}`);
    if (phoneAttempts > RATE_LIMIT_MAX || ipAttempts > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'too-many-requests', retry_after_seconds: 60 });
    }

    // Ищем юзера
    const u = await pool.query(
      `SELECT id, display_name, telegram_id, is_active FROM users WHERE regexp_replace(phone, '\\D', '', 'g') = $1`,
      [phone]
    );
    if (!u.rowCount) {
      return res.status(404).json({ error: 'user-not-found', message: 'Користувача з таким телефоном не знайдено. Зверніться до власника.' });
    }
    if (!u.rows[0].is_active) {
      return res.status(403).json({ error: 'user-disabled', message: 'Акаунт деактивовано.' });
    }
    if (!u.rows[0].telegram_id) {
      return res.status(400).json({ error: 'no-telegram-linked', message: 'Telegram не привʼязано. Зверніться до власника.' });
    }
    const user = u.rows[0];

    // Сначала ПРОБУЕМ отправить код в Telegram. И ТОЛЬКО при успехе —
    // инвалидируем старые и вставляем новый. Иначе юзер навсегда без кода.
    const code = gen6();
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);

    try {
      const result = await sendOtpToUser({
        telegram_id: user.telegram_id,
        phone,
        text: `<b>SVS CRM — код входу</b>\n` +
              `<code>${code}</code>\n` +
              `Дійсний ${CODE_TTL_MIN} хв. Якщо це були не ви — проігноруйте.`,
      });
      console.log('[auth-staff:request] tg-sent via', result.via);
    } catch (e) {
      console.error('[auth-staff:request] tg-send-failed', e.message);
      return res.status(503).json({
        error: 'tg-send-failed',
        message: 'Не вдалося відправити код у Telegram. Спробуйте ще раз або зверніться до власника.',
        detail: e.message,
      });
    }

    // TG ОК — инвалидируем старые и вставляем новый
    await pool.query(
      `UPDATE staff_otp_codes SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [user.id]
    );
    await pool.query(
      `INSERT INTO staff_otp_codes (user_id, code_hash, expires_at, ip)
       VALUES ($1, $2, $3, $4)`,
      [user.id, codeHash, expiresAt, ip]
    );

    res.json({ ok: true, message: 'Код відправлено у Telegram' });
  } catch (e) {
    console.error('[auth-staff:request]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

// ── POST /api/auth/staff/verify ──────────────────────────────────────
// Сверяем код. На успех — выдаём session token (записываем hash в user_tokens).
router.post('/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'phone-and-6digit-code-required' });

    const pool = getPool();
    const codeHash = sha256(code);

    // Тащим самый свежий активный код этого пользователя
    const r = await pool.query(
      `SELECT o.id, o.user_id, o.code_hash, o.attempts, o.max_attempts, o.expires_at, u.display_name, u.role_id, u.is_active
       FROM staff_otp_codes o
       JOIN users u ON u.id = o.user_id
       WHERE regexp_replace(u.phone, '\\D', '', 'g') = $1 AND o.used_at IS NULL
       ORDER BY o.created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rowCount) return res.status(401).json({ error: 'invalid-or-expired' });
    const row = r.rows[0];

    if (!row.is_active) return res.status(401).json({ error: 'user-disabled' });
    if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: 'invalid-or-expired' });
    if (row.attempts >= row.max_attempts) {
      await pool.query(`UPDATE staff_otp_codes SET used_at = NOW() WHERE id = $1`, [row.id]);
      return res.status(401).json({ error: 'max-attempts-exceeded' });
    }

    if (row.code_hash !== codeHash) {
      await pool.query(`UPDATE staff_otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      return res.status(401).json({ error: 'invalid-or-expired', attempts_left: row.max_attempts - row.attempts - 1 });
    }

    // Код верный — помечаем использованным, выдаём session token
    await pool.query(`UPDATE staff_otp_codes SET used_at = NOW() WHERE id = $1`, [row.id]);

    // remember=true → «запомнить навсегда» (10 лет), иначе 14 дней
    const ttlDays = req.body?.remember ? REMEMBER_TTL_DAYS : SESSION_TTL_DAYS;
    const { token, expiresAt } = await issueSessionToken(pool, {
      userId: row.user_id, displayName: row.display_name, roleId: row.role_id,
      req, ttlDays, method: 'telegram-otp',
    });

    res.json({
      ok: true,
      token,
      expires_at: expiresAt.toISOString(),
      user: { id: row.user_id, display_name: row.display_name, role_id: row.role_id },
    });
  } catch (e) {
    console.error('[auth-staff:verify]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

// ── POST /api/auth/staff/logout ──────────────────────────────────────
// Инвалидируем токен (по заголовку Authorization: Bearer <token>)
router.post('/logout', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (!m) return res.status(400).json({ error: 'no-bearer-token' });
    const tokenHash = sha256(m[1]);
    const pool = getPool();
    const r = await pool.query(
      `DELETE FROM user_tokens WHERE token_hash = $1 RETURNING user_id`,
      [tokenHash]
    );
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[auth-staff:logout]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /api/auth/staff/me ───────────────────────────────────────────
// Кто я (по Authorization: Bearer <token>)
router.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (!m) return res.status(401).json({ error: 'no-bearer-token' });
    const tokenHash = sha256(m[1]);
    const pool = getPool();
    const r = await pool.query(
      `SELECT u.id, u.phone, u.display_name, u.role_id, u.branch_id, r.code as role_code, r.permissions,
              (u.password_hash IS NOT NULL) AS has_password
       FROM user_tokens t
       JOIN users u ON u.id = t.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW()) AND u.is_active = true`,
      [tokenHash]
    );
    if (!r.rowCount) return res.status(401).json({ error: 'invalid-or-expired-token' });

    // last_used обновляем "fire and forget"
    pool.query(`UPDATE user_tokens SET last_used = NOW() WHERE token_hash = $1`, [tokenHash]).catch(() => {});

    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error('[auth-staff:me]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── POST /api/auth/staff/login-password ──────────────────────────────
// Быстрый вход по телефону + паролю (альтернатива OTP). Пароль задаётся
// в кабинете. remember=true → сессия на 10 лет.
router.post('/login-password', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    if (!phone || !password) return res.status(400).json({ error: 'phone-and-password-required' });

    const pool = getPool();
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // Тот же rate-limit что и у OTP: 3/мин на phone и на ip
    const phoneAttempts = await throttle(pool, `pwd:phone:${phone}`);
    const ipAttempts = await throttle(pool, `pwd:ip:${ip || 'unknown'}`);
    if (phoneAttempts > RATE_LIMIT_MAX || ipAttempts > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'too-many-requests', retry_after_seconds: 60 });
    }

    const u = await pool.query(
      `SELECT id, display_name, role_id, password_hash, is_active FROM users WHERE regexp_replace(phone, '\\D', '', 'g') = $1`,
      [phone]
    );
    // Единый ответ при любой неудаче — не раскрываем, есть ли юзер/пароль
    const fail = () => res.status(401).json({ error: 'invalid-credentials' });
    if (!u.rowCount) return fail();
    const user = u.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'user-disabled' });
    if (!user.password_hash) return res.status(400).json({ error: 'password-not-set', message: 'Пароль не встановлено. Увійдіть через Telegram-код і встановіть пароль у кабінеті.' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return fail();

    const ttlDays = req.body?.remember ? REMEMBER_TTL_DAYS : SESSION_TTL_DAYS;
    const { token, expiresAt } = await issueSessionToken(pool, {
      userId: user.id, displayName: user.display_name, roleId: user.role_id,
      req, ttlDays, method: 'password',
    });
    res.json({ ok: true, token, expires_at: expiresAt.toISOString(),
      user: { id: user.id, display_name: user.display_name, role_id: user.role_id } });
  } catch (e) {
    console.error('[auth-staff:login-password]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

// ── POST /api/auth/staff/set-password ────────────────────────────────
// Сменить/установить собственный пароль. Требует активной сессии (Bearer).
// Если пароль уже стоял — нужен current_password. Минимум 4 символа.
router.post('/set-password', async (req, res) => {
  try {
    const pool = getPool();
    const me = await userByBearer(pool, req);
    if (!me) return res.status(401).json({ error: 'unauthorized' });

    const next = String(req.body?.password || '');
    if (next.length < 6) return res.status(400).json({ error: 'password-too-short', message: 'Мінімум 6 символів' });

    // Если пароль уже установлен — проверяем текущий (защита от смены чужой открытой сессией)
    if (me.password_hash) {
      const cur = String(req.body?.current_password || '');
      const ok = cur && await verifyPassword(cur, me.password_hash);
      if (!ok) return res.status(403).json({ error: 'current-password-wrong', message: 'Невірний поточний пароль' });
    }

    const hash = await hashPassword(next);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, me.id]);
    await pool.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, meta)
       VALUES ($1, $2, 'auth.set_password', 'user', $3, $4)`,
      [me.id, me.display_name, me.id, JSON.stringify({ changed: !!me.password_hash })]
    );
    res.json({ ok: true, message: me.password_hash ? 'Пароль змінено' : 'Пароль встановлено' });
  } catch (e) {
    console.error('[auth-staff:set-password]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

module.exports = router;
