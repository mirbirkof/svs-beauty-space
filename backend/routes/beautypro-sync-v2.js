/*
 * BeautyPro Sync V2 — свіжа реалізація з обов'язковим параметром fields
 * Замість поламаного beautyproClient.js — прямі виклики до api.aihelps.com
 *
 * Endpoints:
 *   POST /api/sync/v2/client      — синхро одного по телефону (admin)
 *   POST /api/sync/v2/all-clients — масова синхро (admin)
 *   GET  /api/sync/v2/status      — статистика лінкування
 *   GET  /api/sync/v2/health      — перевірка з'єднання з BeautyPro
 */
const express = require('express');
const https = require('https');
const { getPool } = require('../db-pg');
const pool = { query: (...args) => getPool().query(...args) };

const router = express.Router();

const APP_ID = process.env.BEAUTYPRO_ID_KEY;
const SECRET = process.env.BEAUTYPRO_SECRET_KEY;
const DATABASE_CODE = process.env.BEAUTYPRO_DATABASE_CODE || '664684';
const LOCATION = process.env.BEAUTYPRO_LOCATION_ID || '88de9f7c-c225-02e0-597c-7a296e9d6499';
const HOST = 'api.aihelps.com';

// Token cache
let cachedToken = null;
let tokenExpiry = 0;

function adminOnly(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (!t || t !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function httpsRequest(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const req = https.request({
      hostname: HOST,
      path: '/v1' + path,
      method,
      headers,
      timeout: 15000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: json, raw: buf });
        } else {
          const err = new Error(`BeautyPro ${res.statusCode}: ${buf.slice(0, 300)}`);
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!APP_ID || !SECRET) throw new Error('BeautyPro keys missing in env');
  const path = `/auth/database?application_id=${encodeURIComponent(APP_ID)}` +
               `&application_secret=${encodeURIComponent(SECRET)}` +
               `&database_code=${encodeURIComponent(DATABASE_CODE)}`;
  const r = await httpsRequest('GET', path);
  if (!r.data || !r.data.access_token) throw new Error('No token in BP response');
  cachedToken = r.data.access_token;
  tokenExpiry = Date.now() + 20 * 60 * 60 * 1000; // 20h
  return cachedToken;
}

const CLIENT_FIELDS = 'name,firstname,lastname,phone,email,birthday,bonus,balance';

async function bpSearchByPhone(phone) {
  const token = await getToken();
  const path = `/clients?fields=${encodeURIComponent(CLIENT_FIELDS)}&phone=${encodeURIComponent(phone)}`;
  const r = await httpsRequest('GET', path, { token });
  const list = (r.data && (r.data.data || r.data.items || r.data)) || [];
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function bpCreateClient({ phone, name, email }) {
  const token = await getToken();
  const path = `/clients?fields=${encodeURIComponent(CLIENT_FIELDS)}`;
  // BeautyPro вимагає firstname (name read-only, обчислюється з частин)
  let firstname = 'Клієнт', lastname = '';
  if (name && typeof name === 'string') {
    const parts = name.trim().split(/\s+/);
    firstname = parts[0] || 'Клієнт';
    lastname = parts.slice(1).join(' ');
  }
  const body = {
    phone,
    firstname,
    lastname: lastname || null,
    email: email || null,
    location: LOCATION,
  };
  const r = await httpsRequest('POST', path, { token, body });
  return r.data;
}

function normalizePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 9) return '380' + d;
  return d;
}

async function syncOneClient(localClient) {
  const phone = normalizePhone(localClient.phone);
  if (!phone) return { ok: false, error: 'phone-required' };
  try {
    let bp = await bpSearchByPhone(phone);
    let action = 'found';
    if (!bp) {
      bp = await bpCreateClient({ phone, name: localClient.name, email: localClient.email });
      action = 'created';
    }
    const bpId = bp.id || bp.client_id || bp.uuid;
    if (!bpId) return { ok: false, error: 'no-bp-id', bpRaw: bp };
    await pool.query(
      `UPDATE clients SET beautypro_id = $1, updated_at = NOW() WHERE id = $2`,
      [bpId, localClient.id]
    );
    return { ok: true, action, bp_id: bpId, local_id: localClient.id };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

// ===== ROUTES =====

router.get('/health', async (req, res) => {
  try {
    const t = await getToken();
    res.json({ ok: true, token: t ? 'ready' : 'missing', cached: !!cachedToken });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

router.post('/client', adminOnly, async (req, res) => {
  const { phone, client_id } = req.body || {};
  let local;
  if (client_id) {
    const r = await pool.query('SELECT id, phone, name, email FROM clients WHERE id = $1', [client_id]);
    local = r.rows[0];
  } else if (phone) {
    const n = normalizePhone(phone);
    let r = await pool.query('SELECT id, phone, name, email FROM clients WHERE phone = $1', [n]);
    if (!r.rows[0]) {
      const ins = await pool.query(
        `INSERT INTO clients (phone, source) VALUES ($1,'bp-sync') RETURNING id, phone, name, email`,
        [n]
      );
      local = ins.rows[0];
    } else {
      local = r.rows[0];
    }
  } else {
    return res.status(400).json({ error: 'phone-or-client_id-required' });
  }
  if (!local) return res.status(404).json({ error: 'client-not-found' });
  const result = await syncOneClient(local);
  res.json(result);
});

router.post('/all-clients', adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT id, phone, name, email FROM clients
     WHERE beautypro_id IS NULL AND phone IS NOT NULL LIMIT 50`
  );
  const results = [];
  for (const c of r.rows) {
    const out = await syncOneClient(c);
    results.push({ id: c.id, phone: c.phone, ...out });
    await new Promise(r => setTimeout(r, 100)); // rate limit
  }
  const linked = results.filter(x => x.ok).length;
  res.json({ ok: true, processed: results.length, linked, results });
});

router.get('/status', adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE beautypro_id IS NOT NULL) AS linked,
       COUNT(*) FILTER (WHERE beautypro_id IS NULL) AS unlinked,
       COUNT(*) AS total
     FROM clients WHERE phone IS NOT NULL`
  );
  res.json({ ok: true, sync: r.rows[0] });
});

module.exports = router;
module.exports.syncOneClient = syncOneClient;
module.exports.bpSearchByPhone = bpSearchByPhone;
