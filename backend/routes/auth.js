/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Auth Routes
   POST /api/auth/sms/send        → send SMS code (masters)
   POST /api/auth/sms/verify      → verify code → JWT
   POST /api/auth/oauth/google    → verify Google token → JWT
   POST /api/auth/oauth/facebook  → verify FB token → JWT
   POST /api/auth/oauth/apple     → verify Apple token → JWT
   GET  /api/auth/me              → get current user
   POST /api/auth/logout          → invalidate session
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const https = require('https');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'svs-dev-secret';
const JWT_EXPIRES = '30d';

// Twilio client (lazy init)
let twilioClient = null;
function getTwilio() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// ── Helpers ────────────────────────────────────────────
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createJWT(user) {
  return jwt.sign(
    { id: user.id, role: user.role, phone: user.phone, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

function normalizePhone(phone) {
  // Normalize Ukrainian phone to +380XXXXXXXXX
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('380')) return '+' + p;
  if (p.startsWith('80')) return '+3' + p;
  if (p.length === 10 && p.startsWith('0')) return '+38' + p;
  if (p.length === 9) return '+380' + p;
  return '+' + p;
}

// ── SMS: Send code ─────────────────────────────────────
router.post('/sms/send', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Номер телефону обов\'язковий' });

    const normalized = normalizePhone(phone);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Save code to DB
    db.prepare(`
      DELETE FROM sms_codes WHERE phone = ? AND used = 0
    `).run(normalized);

    db.prepare(`
      INSERT INTO sms_codes (phone, code, expires_at) VALUES (?, ?, ?)
    `).run(normalized, code, expiresAt);

    // Send SMS via Twilio
    const tc = getTwilio();
    if (tc && process.env.TWILIO_PHONE_NUMBER) {
      await tc.messages.create({
        body: `SVS Beauty Space: ваш код підтвердження ${code}. Дійсний 10 хвилин.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: normalized,
      });
    } else {
      // Dev mode: log code
      console.log('[SMS-DEV] Code for', normalized, ':', code);
    }

    res.json({ ok: true, message: 'SMS відправлено' });
  } catch (err) {
    console.error('[SMS Send]', err.message);
    res.status(500).json({ error: 'Помилка відправки SMS' });
  }
});

// ── SMS: Verify code ───────────────────────────────────
router.post('/sms/verify', (req, res) => {
  try {
    const { phone, code, name } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Номер та код обов\'язкові' });

    const normalized = normalizePhone(phone);
    const now = new Date().toISOString();

    const row = db.prepare(`
      SELECT * FROM sms_codes
      WHERE phone = ? AND code = ? AND used = 0 AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1
    `).get(normalized, code, now);

    if (!row) return res.status(400).json({ error: 'Невірний або прострочений код' });

    // Mark as used
    db.prepare('UPDATE sms_codes SET used = 1 WHERE id = ?').run(row.id);

    // Find or create user (master role)
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized);
    if (!user) {
      const result = db.prepare(`
        INSERT INTO users (phone, name, role, provider, approved)
        VALUES (?, ?, 'master', 'phone', 0)
      `).run(normalized, name || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    // Update last login
    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);

    const token = createJWT(user);
    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        approved: user.approved === 1,
      }
    });
  } catch (err) {
    console.error('[SMS Verify]', err.message);
    res.status(500).json({ error: 'Помилка верифікації' });
  }
});

// ── Google OAuth ────────────────────────────────────────
router.post('/oauth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential required' });

    // Verify Google ID token
    const googleUser = await verifyGoogleToken(credential);
    if (!googleUser) return res.status(400).json({ error: 'Invalid Google token' });

    let user = db.prepare('SELECT * FROM users WHERE provider = "google" AND provider_id = ?').get(googleUser.sub);
    if (!user) {
      // Check by email
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(googleUser.email);
    }

    if (!user) {
      const result = db.prepare(`
        INSERT INTO users (email, name, role, provider, provider_id, avatar, approved)
        VALUES (?, ?, 'user', 'google', ?, ?, 1)
      `).run(googleUser.email, googleUser.name, googleUser.sub, googleUser.picture || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    } else if (user.provider !== 'google') {
      // Update provider info
      db.prepare('UPDATE users SET provider = "google", provider_id = ?, avatar = ? WHERE id = ?')
        .run(googleUser.sub, googleUser.picture || user.avatar, user.id);
    }

    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);

    const token = createJWT(user);
    res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar }
    });
  } catch (err) {
    console.error('[Google OAuth]', err.message);
    res.status(500).json({ error: 'Google auth failed' });
  }
});

// Verify Google ID token via Google's tokeninfo endpoint
function verifyGoogleToken(credential) {
  return new Promise((resolve, reject) => {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + credential;
    https.get(url, (resp) => {
      let data = '';
      resp.on('data', (chunk) => data += chunk);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return resolve(null);
          // Verify audience
          if (process.env.GOOGLE_CLIENT_ID && parsed.aud !== process.env.GOOGLE_CLIENT_ID) {
            return resolve(null);
          }
          resolve(parsed);
        } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ── Facebook OAuth ──────────────────────────────────────
router.post('/oauth/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Facebook access token required' });

    const fbUser = await verifyFacebookToken(accessToken);
    if (!fbUser) return res.status(400).json({ error: 'Invalid Facebook token' });

    let user = db.prepare('SELECT * FROM users WHERE provider = "facebook" AND provider_id = ?').get(fbUser.id);
    if (!user && fbUser.email) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(fbUser.email);
    }

    if (!user) {
      const result = db.prepare(`
        INSERT INTO users (email, name, role, provider, provider_id, avatar, approved)
        VALUES (?, ?, 'user', 'facebook', ?, ?, 1)
      `).run(fbUser.email || null, fbUser.name, fbUser.id, fbUser.picture?.data?.url || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);
    const token = createJWT(user);
    res.json({
      ok: true, token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error('[FB OAuth]', err.message);
    res.status(500).json({ error: 'Facebook auth failed' });
  }
});

function verifyFacebookToken(accessToken) {
  return new Promise((resolve, reject) => {
    const url = 'https://graph.facebook.com/me?fields=id,name,email,picture&access_token=' + accessToken;
    https.get(url, (resp) => {
      let data = '';
      resp.on('data', (c) => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return resolve(null);
          resolve(parsed);
        } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ── Apple OAuth ─────────────────────────────────────────
router.post('/oauth/apple', async (req, res) => {
  try {
    const { identityToken, user: appleUserData } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Apple identity token required' });

    // Decode JWT without verifying (Apple's public key verification is complex)
    // In production, verify with Apple's public keys from https://appleid.apple.com/auth/keys
    const parts = identityToken.split('.');
    if (parts.length < 2) return res.status(400).json({ error: 'Invalid Apple token' });

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      return res.status(400).json({ error: 'Invalid Apple token payload' });
    }

    const appleId = payload.sub;
    const email = payload.email || (appleUserData && appleUserData.email);
    const name = appleUserData && appleUserData.name
      ? `${appleUserData.name.firstName || ''} ${appleUserData.name.lastName || ''}`.trim()
      : null;

    if (!appleId) return res.status(400).json({ error: 'Invalid Apple sub' });

    let user = db.prepare('SELECT * FROM users WHERE provider = "apple" AND provider_id = ?').get(appleId);
    if (!user && email) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    if (!user) {
      const result = db.prepare(`
        INSERT INTO users (email, name, role, provider, provider_id, approved)
        VALUES (?, ?, 'user', 'apple', ?, 1)
      `).run(email || null, name || 'Apple User', appleId);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);
    const token = createJWT(user);
    res.json({
      ok: true, token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error('[Apple OAuth]', err.message);
    res.status(500).json({ error: 'Apple auth failed' });
  }
});

// ── Get current user ────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, phone, email, name, role, avatar, approved, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { ...user, approved: user.approved === 1 } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update profile ──────────────────────────────────────
router.put('/me', authMiddleware, (req, res) => {
  try {
    const { name } = req.body;
    if (name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    }
    const user = db.prepare('SELECT id, phone, email, name, role, avatar FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Logout ──────────────────────────────────────────────
router.post('/logout', authMiddleware, (req, res) => {
  // JWT is stateless, client just deletes token
  res.json({ ok: true });
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
