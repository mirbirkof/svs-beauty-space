/* ═══════════════════════════════════════════════════════
   BeautyPro CRM Client
   Авторизация: application_id + secret → token (24ч), refresh
   Использование:
     await bp.createClient({ phone, name })
     await bp.createAppointment({ client_id, service_id, employee_id, date_from, date_to, location_id })
   ═══════════════════════════════════════════════════════ */
const https = require('https');

const BASE = 'https://api.aihelps.com/v1';
const APP_ID = process.env.BEAUTYPRO_ID_KEY;
const SECRET = process.env.BEAUTYPRO_SECRET_KEY;
const DATABASE_CODE = process.env.BEAUTYPRO_DATABASE_CODE || '664684';
const LOCATION = process.env.BEAUTYPRO_LOCATION_ID || '88de9f7c-c225-02e0-597c-7a296e9d6499';

let cache = { token: null, expiresAt: 0, refreshToken: null };

function request(method, path, { token, body, query } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: 'api.aihelps.com',
      path: '/v1' + path + qs,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 400) {
            return reject(new Error(`BeautyPro ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getToken() {
  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60_000) return cache.token;

  // GET /auth/database?application_id&application_secret&database_code
  const res = await request('GET', '/auth/database', {
    query: {
      application_id: APP_ID,
      application_secret: SECRET,
      database_code: DATABASE_CODE,
    },
  });
  cache.token = res.access_token || res.token;
  cache.refreshToken = res.refresh_token;
  cache.expiresAt = now + (res.expires_in ? res.expires_in * 1000 : 23 * 3600 * 1000);
  return cache.token;
}

async function findClientByPhone(phone) {
  const token = await getToken();
  // BP теперь требует fields= на каждом GET. id всегда возвращается, в fields его указывать НЕЛЬЗЯ.
  const res = await request('GET', '/clients', {
    token,
    query: { phone, fields: 'firstname,lastname,phone,email' },
  });
  const list = res.data || res.items || res;
  return Array.isArray(list) && list.length ? list[0] : null;
}

function splitName(full) {
  const s = String(full || '').trim();
  if (!s) return { firstname: 'Клієнт', lastname: '' };
  const parts = s.split(/\s+/);
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

async function createClient({ phone, name, firstname, lastname, email }) {
  const existing = await findClientByPhone(phone);
  if (existing) return existing;
  const token = await getToken();
  // BP запретил поле name в POST /clients — оно read-only. Только firstname + lastname.
  const fn = firstname || (name ? splitName(name).firstname : 'Клієнт');
  const ln = lastname  || (name ? splitName(name).lastname  : '');
  const body = { phone, firstname: fn };
  if (ln)    body.lastname = ln;
  if (email) body.email = email;
  return request('POST', '/clients', { token, body });
}

async function createAppointment({ client_id, service_id, employee_id, date_from, date_to, location_id, note }) {
  const token = await getToken();
  return request('POST', '/appointments', {
    token,
    body: {
      client: client_id,
      services: [{ service: service_id, professional: employee_id }],
      date_from,
      date_to,
      location: location_id || LOCATION,
      note: note || 'Онлайн-запис з сайту (підтверджено Telegram)',
    },
    query: { force: 'true' },
  });
}

async function listServices() {
  const token = await getToken();
  // BeautyPro API requires explicit fields= param
  return request('GET', '/services', { token, query: { fields: 'name,duration,price,category', archive: 'false' } });
}

async function listEmployees() {
  const token = await getToken();
  return request('GET', '/employees', { token, query: { fields: 'name,services', archive: 'false', location: LOCATION } });
}

async function freeTime({ duration, professional, from, to, location }) {
  const token = await getToken();
  const query = { duration, from, to, location: location || LOCATION, step: '15m' };
  if (professional) query.professionals = professional;
  return request('GET', '/employees/free_time', { token, query });
}

module.exports = {
  createClient,
  createAppointment,
  findClientByPhone,
  listServices,
  listEmployees,
  freeTime,
};
