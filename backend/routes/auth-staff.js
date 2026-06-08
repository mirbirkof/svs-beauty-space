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

const router = express.Router();

const CODE_TTL_MIN = 5;
const SESSION_TTL_DAYS = 14;
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
  return String(p || '').replace(/[^\d+]/g, '');
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

// Admin-only: legacy ADMIN_TOKEN check
function adminOnly(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── POST /api/auth/staff/link  (admin) ───────────────────────────────
// Босс линкует Telegram chat_id к существующему юзеру.
// Юзер ДОЛЖЕН первым нажать /start у уведомлятельного бота
// и сообщить Боссу свой chat_id (или получить его из /api/notify админкой).
router.post('/link', adminOnly, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const telegram_id = parseInt(req.body?.telegram_id, 10);
    if (!phone || !telegram_id) return res.status(400).json({ error: 'phone-and-telegram_id-required' });

    const pool = getPool();
    const r = await pool.query(
      `UPDATE users SET telegram_id = $1, updated_at = NOW() WHERE phone = $2 RETURNING id, display_name, role_id`,
      [telegram_id, phone]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'user-not-found' });

    // Шлём подтверждение в Telegram чтобы убедиться что chat_id живой
    try {
      await tgSend(telegram_id,
        `<b>Telegram прив'язано до акаунту SVS CRM</b>\n` +
        `Тепер ви можете логінитися через OTP-код.\n` +
        `Виклик: введіть телефон ${phone} на сторінці входу — отримаєте код тут.`
      );
    } catch (e) {
      // chat_id неверный или юзер не начал диалог
      return res.status(400).json({
        error: 'telegram-send-failed',
        detail: e.message,
        hint: 'Спочатку напишіть боту /start, потім спробуйте ще раз'
      });
    }

    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error('[auth-staff:link]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
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
      `SELECT id, display_name, telegram_id, is_active FROM users WHERE phone = $1`,
      [phone]
    );
    // Намеренно НЕ раскрываем существует ли юзер — возвращаем ok=true всегда
    // (защита от перебора телефонов сотрудников)
    if (!u.rowCount || !u.rows[0].is_active || !u.rows[0].telegram_id) {
      return res.json({ ok: true, message: 'Якщо телефон зареєстрований і Telegram прив\'язано — код прийде в чат' });
    }
    const user = u.rows[0];

    // Деактивируем все предыдущие неиспользованные коды этого юзера
    await pool.query(
      `UPDATE staff_otp_codes SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [user.id]
    );

    const code = gen6();
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);

    await pool.query(
      `INSERT INTO staff_otp_codes (user_id, code_hash, expires_at, ip)
       VALUES ($1, $2, $3, $4)`,
      [user.id, codeHash, expiresAt, ip]
    );

    try {
      await tgSend(user.telegram_id,
        `<b>SVS CRM — код входу</b>\n` +
        `<code>${code}</code>\n` +
        `Дійсний ${CODE_TTL_MIN} хв. Якщо це були не ви — проігноруйте.`
      );
    } catch (e) {
      // Не раскрываем ошибку клиенту — всё равно вернём ok=true
      console.error('[auth-staff:request] tg-send-failed', e.message);
    }

    res.json({ ok: true, message: 'Якщо телефон зареєстрований і Telegram прив\'язано — код прийде в чат' });
  } catch (e) {
    console.error('[auth-staff:request]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
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
       WHERE u.phone = $1 AND o.used_at IS NULL
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

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

    await pool.query(
      `INSERT INTO user_tokens (user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [row.user_id, tokenHash, `otp-login from ${(req.headers['user-agent'] || '').slice(0, 80)}`, expiresAt]
    );

    // Логируем удачный вход
    await pool.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [row.user_id]
    );
    await pool.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES ($1, $2, 'auth.login', 'user', $3, $4, $5)`,
      [
        row.user_id,
        row.display_name,
        row.user_id,
        (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        JSON.stringify({ method: 'telegram-otp' }),
      ]
    );

    res.json({
      ok: true,
      token,
      expires_at: expiresAt.toISOString(),
      user: { id: row.user_id, display_name: row.display_name, role_id: row.role_id },
    });
  } catch (e) {
    console.error('[auth-staff:verify]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
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
      `SELECT u.id, u.phone, u.display_name, u.role_id, u.branch_id, r.code as role_code, r.permissions
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

module.exports = router;
