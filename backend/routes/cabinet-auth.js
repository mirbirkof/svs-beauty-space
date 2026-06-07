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

const router = express.Router();
const DEV_CODE = '0000';
const TOKEN_TTL_DAYS = 30;

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
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
      const r = await pool.query(
        `SELECT s.id AS sid, s.expires_at, c.*
         FROM sessions s JOIN clients c ON c.id = s.client_id
         WHERE s.token = $1`,
        [token]
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
router.post('/request-code', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 9) return res.status(400).json({ error: 'bad-phone' });

    const pool = getPool();
    const code = process.env.SMS_PROVIDER ? genCode() : DEV_CODE;
    const expires = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      `INSERT INTO sms_codes (phone, code, expires_at, used) VALUES ($1,$2,$3,false)`,
      [phone, code, expires]
    );

    // TODO: при подключении SMS-провайдера — отправить sms
    res.json({
      ok: true,
      mode: process.env.SMS_PROVIDER ? 'sms' : 'dev',
      hint: process.env.SMS_PROVIDER ? null : `dev-code: ${DEV_CODE}`,
    });
  } catch (e) {
    console.error('[auth:request]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── проверка кода → сессия ──────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone-and-code-required' });

    const pool = getPool();

    // в dev-режиме принимаем DEV_CODE без проверки sms_codes
    let codeOk = false;
    if (!process.env.SMS_PROVIDER && code === DEV_CODE) {
      codeOk = true;
    } else {
      const r = await pool.query(
        `SELECT id FROM sms_codes WHERE phone=$1 AND code=$2 AND used=false AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [phone, code]
      );
      if (r.rowCount > 0) {
        await pool.query(`UPDATE sms_codes SET used=true WHERE id=$1`, [r.rows[0].id]);
        codeOk = true;
      }
    }
    if (!codeOk) return res.status(401).json({ error: 'bad-code' });

    // апсёрт клиента
    const cl = await pool.query(
      `INSERT INTO clients (phone, source) VALUES ($1, 'cabinet')
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, phone, name, email, loyalty_points`,
      [phone]
    );
    const client = cl.rows[0];

    const token = genToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400 * 1000);
    await pool.query(
      `INSERT INTO sessions (client_id, token, expires_at, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5)`,
      [client.id, token, expiresAt, req.headers['user-agent'] || '', req.ip]
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
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth:logout]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
module.exports.authClient = authClient;
