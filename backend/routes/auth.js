/* ═══════════════════════════════════════════════════════
   SVS CRM — Auth Routes (full module)

   Endpoints:
     POST   /api/auth/login              login/email/phone + password
     POST   /api/auth/logout             revoke current session
     POST   /api/auth/logout-all         revoke all sessions of user
     POST   /api/auth/refresh-token      rotate refresh token
     POST   /api/auth/forgot-password    issue reset token (existence-leak guard)
     POST   /api/auth/reset-password     consume token, set new password
     POST   /api/auth/change-password    while authenticated
     POST   /api/auth/verify-2fa         second step of login
     GET    /api/auth/me                 current user
     GET    /api/auth/sessions           list active sessions of current user
     DELETE /api/auth/sessions/:id       revoke specific session
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const {
  ACCESS_TTL_SEC,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  PASSWORD_HISTORY_DEPTH,
  sha256,
  hashPassword,
  verifyPassword,
  checkPasswordComplexity,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  generateResetToken,
  refreshTtlMs,
  gen6digit,
  deviceLabelFromUA,
  clientIp,
  normalizePhone,
  normalizeEmail,
  recordAttempt,
  countRecentFailures,
} = require('../lib/auth-core');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── helpers ─────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setRefreshCookie(res, token, ttlMs) {
  const parts = [
    `svs_refresh=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/api/auth',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearRefreshCookie(res) {
  res.setHeader('Set-Cookie', 'svs_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0');
}

async function findUserByIdentifier(client, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  // detect type
  if (id.includes('@')) {
    const email = normalizeEmail(id);
    const r = await client.query(
      `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
         FROM users u LEFT JOIN roles r ON r.id=u.role_id
        WHERE LOWER(u.email)=$1 LIMIT 1`,
      [email]
    );
    return r.rows[0] || null;
  }
  if (/^[\+\d\s\-\(\)]+$/.test(id)) {
    const phone = normalizePhone(id);
    const r = await client.query(
      `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
         FROM users u LEFT JOIN roles r ON r.id=u.role_id
        WHERE u.phone=$1 LIMIT 1`,
      [phone]
    );
    return r.rows[0] || null;
  }
  // username
  const r = await client.query(
    `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
       FROM users u LEFT JOIN roles r ON r.id=u.role_id
      WHERE LOWER(u.username)=LOWER($1) LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

async function issueSession(client, { user, req, rememberMe }) {
  const refreshToken = generateRefreshToken();
  const refreshHash = sha256(refreshToken);
  const ttlMs = refreshTtlMs(rememberMe);
  const expiresAt = new Date(Date.now() + ttlMs);
  const ua = req.headers['user-agent'] || '';
  const label = deviceLabelFromUA(ua);
  const ip = clientIp(req);

  const sess = await client.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, device_label, user_agent, ip, remember_me, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [user.id, refreshHash, label, ua.slice(0, 500), ip, !!rememberMe, expiresAt]
  );

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role_code || null,
    sid: sess.rows[0].id,
  });

  return { accessToken, refreshToken, refreshTtlMs: ttlMs, sessionId: sess.rows[0].id, expiresAt };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    display_name: u.display_name,
    role: u.role_code,
    permissions: u.role_permissions,
    email_verified: u.email_verified,
    phone_verified: u.phone_verified,
    two_factor_enabled: u.two_factor_enabled,
    two_factor_channel: u.two_factor_channel,
    branch_id: u.branch_id,
    master_id: u.master_id,
  };
}

// Telegram delivery (uses TELEGRAM_NOTIFY_TOKEN + user.telegram_id if exists)
async function deliverViaTelegram(user, text) {
  const token = process.env.TELEGRAM_NOTIFY_TOKEN || process.env.JARVIS_BOT_TOKEN;
  const chatId = user.telegram_id || user.tg_chat_id;
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch { return false; }
}

// ── authRequired middleware (also exported) ─────────────
async function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: 'no-token' });
    const decoded = verifyAccessToken(m[1]);
    if (!decoded) return res.status(401).json({ ok: false, error: 'invalid-token' });

    const r = await pool.query(
      `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
         FROM users u LEFT JOIN roles r ON r.id=u.role_id
        WHERE u.id=$1 AND u.is_active=TRUE LIMIT 1`,
      [decoded.sub]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'user-not-found' });

    // ensure session still active (revoked_at IS NULL)
    if (decoded.sid) {
      const s = await pool.query(
        `SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > NOW()`,
        [decoded.sid, user.id]
      );
      if (!s.rows[0]) return res.status(401).json({ ok: false, error: 'session-revoked' });
    }

    req.user = user;
    req.sessionId = decoded.sid || null;
    req.tokenPayload = decoded;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: 'auth-mw-failed', detail: e.message });
  }
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/login
// body: { identifier, password, remember_me? }
// returns: { ok, requires_2fa?, pre_auth_token?, token?, refresh?, user? }
// ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { identifier, password, remember_me } = req.body || {};
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: 'identifier-and-password-required' });
  }

  try {
    // global IP-based rate limit
    const ipFailures = await countRecentFailures(pool, ip || 'unknown', 'login', 15);
    if (ipFailures >= 20) {
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'ip-rate-limit' } });
      return res.status(429).json({ ok: false, error: 'too-many-attempts-ip' });
    }

    const user = await findUserByIdentifier(pool, identifier);
    if (!user) {
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'user-not-found' } });
      return res.status(401).json({ ok: false, error: 'invalid-credentials' });
    }

    // lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'locked' } });
      return res.status(423).json({ ok: false, error: 'account-locked', locked_until: user.locked_until });
    }

    if (!user.is_active) {
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'inactive' } });
      return res.status(403).json({ ok: false, error: 'account-inactive' });
    }

    if (!user.password_hash) {
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'no-password-set' } });
      return res.status(401).json({ ok: false, error: 'no-password-set-use-otp' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const newCount = (user.failed_login_attempts || 0) + 1;
      let lockedUntil = null;
      if (newCount >= MAX_FAILED_LOGINS) {
        lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      }
      await pool.query(
        `UPDATE users SET failed_login_attempts=$1, locked_until=$2 WHERE id=$3`,
        [newCount, lockedUntil, user.id]
      );
      await recordAttempt(pool, { identifier, kind: 'login', success: false, ip, ua, meta: { reason: 'bad-password', attempts: newCount } });
      return res.status(401).json({ ok: false, error: 'invalid-credentials', attempts_left: Math.max(0, MAX_FAILED_LOGINS - newCount) });
    }

    // reset failure counters
    await pool.query(`UPDATE users SET failed_login_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE id=$1`, [user.id]);

    // 2FA branch
    if (user.two_factor_enabled) {
      const code = gen6digit();
      const codeHash = sha256(code);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min
      await pool.query(
        `INSERT INTO two_factor_codes (user_id, code_hash, channel, expires_at) VALUES ($1,$2,$3,$4)`,
        [user.id, codeHash, user.two_factor_channel || 'telegram', expiresAt]
      );
      await deliverViaTelegram(user, `🔐 <b>SVS CRM</b>\nКод підтвердження: <code>${code}</code>\nДіє 5 хв.`);

      const preToken = jwt.sign(
        { sub: user.id, typ: '2fa_pending' },
        process.env.JWT_SECRET || 'svs-fallback-secret-do-not-use-in-prod',
        { expiresIn: 600, issuer: 'svs-crm' }
      );
      await recordAttempt(pool, { identifier, kind: 'login', success: true, ip, ua, meta: { stage: '2fa-required' } });
      return res.json({ ok: true, requires_2fa: true, pre_auth_token: preToken, channel: user.two_factor_channel || 'telegram' });
    }

    const { accessToken, refreshToken, refreshTtlMs: ttlMs, expiresAt } = await issueSession(pool, { user, req, rememberMe: remember_me });
    setRefreshCookie(res, refreshToken, ttlMs);
    await recordAttempt(pool, { identifier, kind: 'login', success: true, ip, ua, meta: {} });

    res.json({
      ok: true,
      token: accessToken,
      token_expires_in: ACCESS_TTL_SEC,
      refresh: refreshToken, // also returned for non-cookie clients
      refresh_expires_at: expiresAt,
      user: publicUser(user),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'login-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/verify-2fa
// body: { pre_auth_token, code, remember_me? }
// ─────────────────────────────────────────────────────────
router.post('/verify-2fa', async (req, res) => {
  const { pre_auth_token, code, remember_me } = req.body || {};
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  if (!pre_auth_token || !code) return res.status(400).json({ ok: false, error: 'token-and-code-required' });

  try {
    let decoded;
    try {
      decoded = jwt.verify(pre_auth_token, process.env.JWT_SECRET || 'svs-fallback-secret-do-not-use-in-prod', { issuer: 'svs-crm' });
    } catch { return res.status(401).json({ ok: false, error: 'pre-auth-token-invalid' }); }
    if (decoded.typ !== '2fa_pending') return res.status(401).json({ ok: false, error: 'wrong-token-type' });

    const userR = await pool.query(
      `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
         FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`,
      [decoded.sub]
    );
    const user = userR.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'user-not-found' });

    const codeHash = sha256(code);
    const r = await pool.query(
      `SELECT * FROM two_factor_codes
        WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
      [user.id, codeHash]
    );
    const row = r.rows[0];
    if (!row) {
      // bump attempts on latest pending code (if any) for visibility
      await pool.query(`UPDATE two_factor_codes SET attempts=attempts+1 WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
      await recordAttempt(pool, { identifier: String(user.id), kind: 'verify_2fa', success: false, ip, ua, meta: {} });
      return res.status(401).json({ ok: false, error: 'invalid-or-expired' });
    }
    await pool.query(`UPDATE two_factor_codes SET used_at=NOW() WHERE id=$1`, [row.id]);

    const { accessToken, refreshToken, refreshTtlMs: ttlMs, expiresAt } = await issueSession(pool, { user, req, rememberMe: remember_me });
    setRefreshCookie(res, refreshToken, ttlMs);
    await recordAttempt(pool, { identifier: String(user.id), kind: 'verify_2fa', success: true, ip, ua, meta: {} });

    res.json({
      ok: true,
      token: accessToken,
      token_expires_in: ACCESS_TTL_SEC,
      refresh: refreshToken,
      refresh_expires_at: expiresAt,
      user: publicUser(user),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'verify-2fa-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/refresh-token
// body: { refresh? } OR cookie svs_refresh
// rotates the refresh token (revokes old session, creates new)
// ─────────────────────────────────────────────────────────
router.post('/refresh-token', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const refresh = (req.body && req.body.refresh) || cookies.svs_refresh;
    if (!refresh) return res.status(401).json({ ok: false, error: 'no-refresh' });

    const hash = sha256(refresh);
    const s = await pool.query(
      `SELECT s.*, u.is_active FROM user_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
        LIMIT 1`,
      [hash]
    );
    const session = s.rows[0];
    if (!session || !session.is_active) {
      return res.status(401).json({ ok: false, error: 'refresh-invalid-or-expired' });
    }

    // load user
    const ur = await pool.query(
      `SELECT u.*, r.code AS role_code, r.permissions AS role_permissions
         FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`,
      [session.user_id]
    );
    const user = ur.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'user-not-found' });

    // rotate: revoke old, create new
    await pool.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1`, [session.id]);
    const { accessToken, refreshToken, refreshTtlMs: ttlMs, expiresAt } = await issueSession(pool, { user, req, rememberMe: session.remember_me });
    setRefreshCookie(res, refreshToken, ttlMs);

    res.json({
      ok: true,
      token: accessToken,
      token_expires_in: ACCESS_TTL_SEC,
      refresh: refreshToken,
      refresh_expires_at: expiresAt,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'refresh-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/logout — revoke current session
// ─────────────────────────────────────────────────────────
router.post('/logout', authRequired, async (req, res) => {
  try {
    if (req.sessionId) {
      await pool.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2`, [req.sessionId, req.user.id]);
    }
    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'logout-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/logout-all — revoke all sessions
// ─────────────────────────────────────────────────────────
router.post('/logout-all', authRequired, async (req, res) => {
  try {
    await pool.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [req.user.id]);
    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'logout-all-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// body: { identifier } — email/phone/username
// always returns { ok:true } to avoid existence leak
// ─────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { identifier } = req.body || {};
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  if (!identifier) return res.json({ ok: true });

  try {
    const failures = await countRecentFailures(pool, identifier, 'reset', 15);
    if (failures >= 5) {
      return res.status(429).json({ ok: false, error: 'too-many-reset-attempts' });
    }

    const user = await findUserByIdentifier(pool, identifier);
    if (!user) {
      await recordAttempt(pool, { identifier, kind: 'reset', success: false, ip, ua, meta: { reason: 'user-not-found' } });
      return res.json({ ok: true }); // existence-leak guard
    }

    const token = generateResetToken();
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    const channel = user.email ? 'email' : 'telegram';

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, channel, expires_at, ip) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, tokenHash, channel, expiresAt, ip]
    );

    const base = process.env.PUBLIC_BASE_URL || 'https://svs-shop-api.onrender.com';
    const link = `${base}/admin/reset-password.html?token=${token}`;

    await deliverViaTelegram(user, `🔑 <b>Скидання пароля SVS CRM</b>\nПерейдіть за посиланням, щоб задати новий пароль:\n<a href="${link}">${link}</a>\n\nПосилання дійсне 30 хв. Якщо ви не запитували — проігноруйте.`);
    await recordAttempt(pool, { identifier, kind: 'reset', success: true, ip, ua, meta: { channel } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'forgot-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// body: { token, new_password }
// ─────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ ok: false, error: 'token-and-new-password-required' });

  const complexity = checkPasswordComplexity(new_password);
  if (!complexity.ok) return res.status(400).json({ ok: false, error: 'weak-password', issues: complexity.errors });

  try {
    const hash = sha256(token);
    const r = await pool.query(
      `SELECT * FROM password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
      [hash]
    );
    const row = r.rows[0];
    if (!row) return res.status(401).json({ ok: false, error: 'token-invalid-or-expired' });

    // check password history
    const hist = await pool.query(
      `SELECT password_hash FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [row.user_id, PASSWORD_HISTORY_DEPTH]
    );
    for (const h of hist.rows) {
      if (await verifyPassword(new_password, h.password_hash)) {
        return res.status(400).json({ ok: false, error: 'password-reused' });
      }
    }

    const newHash = await hashPassword(new_password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET password_hash=$1, password_changed_at=NOW(), failed_login_attempts=0, locked_until=NULL WHERE id=$2`, [newHash, row.user_id]);
      await client.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)`, [row.user_id, newHash]);
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1`, [row.id]);
      // revoke all sessions (force re-login)
      await client.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [row.user_id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    res.json({ ok: true, message: 'Пароль оновлено. Увійдіть знову.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'reset-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/change-password
// body: { current_password, new_password }
// ─────────────────────────────────────────────────────────
router.post('/change-password', authRequired, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ ok: false, error: 'both-passwords-required' });

  const complexity = checkPasswordComplexity(new_password);
  if (!complexity.ok) return res.status(400).json({ ok: false, error: 'weak-password', issues: complexity.errors });

  try {
    if (!req.user.password_hash || !(await verifyPassword(current_password, req.user.password_hash))) {
      return res.status(401).json({ ok: false, error: 'current-password-wrong' });
    }

    const hist = await pool.query(
      `SELECT password_hash FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [req.user.id, PASSWORD_HISTORY_DEPTH]
    );
    for (const h of hist.rows) {
      if (await verifyPassword(new_password, h.password_hash)) {
        return res.status(400).json({ ok: false, error: 'password-reused' });
      }
    }

    const newHash = await hashPassword(new_password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET password_hash=$1, password_changed_at=NOW() WHERE id=$2`, [newHash, req.user.id]);
      await client.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)`, [req.user.id, newHash]);
      // keep current session, revoke others
      await client.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=$1 AND id <> $2 AND revoked_at IS NULL`, [req.user.id, req.sessionId || 0]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'change-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────
router.get('/me', authRequired, async (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

// ─────────────────────────────────────────────────────────
// GET /api/auth/sessions — list active sessions of current user
// ─────────────────────────────────────────────────────────
router.get('/sessions', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, device_label, ip, remember_me, last_used_at, expires_at, created_at,
              (id = $1) AS is_current
         FROM user_sessions
        WHERE user_id=$2 AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [req.sessionId || 0, req.user.id]
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'sessions-failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/auth/sessions/:id — revoke specific session
// ─────────────────────────────────────────────────────────
router.delete('/sessions/:id', authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(
      `UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'session-not-found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'session-revoke-failed', detail: e.message });
  }
});

module.exports = router;
module.exports.authRequired = authRequired;
