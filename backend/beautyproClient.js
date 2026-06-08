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
let pendingAuth = null; // dedup concurrent getToken() calls

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

  // Dedup: if auth is already in-flight, wait for that same promise
  if (pendingAuth) return pendingAuth;

  pendingAuth = (async () => {
    const res = await request('GET', '/auth/database', {
      query: {
        application_id: APP_ID,
        application_secret: SECRET,
        database_code: DATABASE_CODE,
      },
    });
    cache.token = res.access_token || res.token;
    cache.refreshToken = res.refresh_token;
    cache.expiresAt = Date.now() + (res.expires_in ? res.expires_in * 1000 : 23 * 3600 * 1000);
    return cache.token;
  })();

  try { return await pendingAuth; } finally { pendingAuth = null; }
}

// BP API tightening (verified 2026-06-08): `fields` is required on every request,
// `id` is implicit and rejected in fields list, and `name` is read-only on clients
// (must use firstname/lastname).
const CLIENT_FIELDS = 'firstname,lastname,phone,email';
const APPT_FIELDS = 'date_from,date_to,services,client,location,status';

function splitName(raw) {
  const s = String(raw || 'Клієнт').trim();
  const parts = s.split(/\s+/);
  return { firstname: parts[0] || 'Клієнт', lastname: parts.slice(1).join(' ') || null };
}

async function findClientByPhone(phone) {
  const token = await getToken();
  const res = await request('GET', '/clients', { token, query: { phone, fields: CLIENT_FIELDS } });
  const list = res.data || res.items || res;
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function createClient({ phone, name, email }) {
  const existing = await findClientByPhone(phone);
  if (existing) return existing;
  const token = await getToken();
  const { firstname, lastname } = splitName(name);
  const body = { phone, firstname };
  if (lastname) body.lastname = lastname;
  if (email) body.email = email;
  return request('POST', '/clients', {
    token,
    body,
    query: { fields: CLIENT_FIELDS },
  });
}

// BP schema (verified 2026-06-08):
//   date = 'YYYY-MM-DD'  (date only, no time)
//   services = [{ service, employee, start: 'YYYY-MM-DDTHH:MM:SS', duration }]
// Старый интерфейс booking-server передаёт date_from / date_to (ISO datetime).
// Внутри конвертируем в date + start + duration_minutes.
async function createAppointment({ client_id, service_id, employee_id, date_from, date_to, location_id, note }) {
  const token = await getToken();
  const dt = new Date(date_from);
  const dtEnd = new Date(date_to);
  if (Number.isNaN(dt.getTime()) || Number.isNaN(dtEnd.getTime())) {
    throw new Error('createAppointment: invalid date_from / date_to');
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateOnly = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  const startIso = `${dateOnly}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const duration = Math.max(15, Math.round((dtEnd - dt) / 60000));
  // Назначение мастера идёт через `professional`, а не `employee`
  // (employee — служебное поле BP, возвращается null).
  const fields = 'date,client,location,state,services(start,service,professional,duration)';
  return request('POST', '/appointments', {
    token,
    body: {
      client: client_id,
      location: location_id || LOCATION,
      date: dateOnly,
      services: [{ service: service_id, professional: employee_id, start: startIso, duration }],
      // 'note' BP больше не принимает на верхнем уровне
    },
    query: { force: 'true', fields },
  });
}

// Retry wrapper: on 401 invalidate cache and retry once
async function withRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.message && e.message.includes('401')) {
      cache.token = null; cache.expiresAt = 0;
      return fn();
    }
    throw e;
  }
}

async function listServices() {
  return withRetry(async () => {
    const token = await getToken();
    return request('GET', '/services', { token, query: { fields: 'name,duration,price,category', archive: 'false' } });
  });
}

async function listEmployees() {
  return withRetry(async () => {
    const token = await getToken();
    return request('GET', '/employees', { token, query: { fields: 'name,services,positions', archive: 'false', location: LOCATION } });
  });
}

async function freeTime({ duration, professional, from, to, location }) {
  const token = await getToken();
  return request('GET', '/employees/free_time', {
    token,
    query: { duration, professionals: professional, from, to, location: location || LOCATION, step: '15m' },
  });
}

// GET /schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&location=...
// Повертає робочі зміни майстрів — це справжнє джерело графіків (worktime в /employees порожній).
// Структура: { columns: [{ professional, date, worktime:[{start,end}], reserves, appointments:[apptId] }], appointments: {id: {...}} }
async function getSchedule({ from, to, location } = {}) {
  const token = await getToken();
  return request('GET', '/schedule', {
    token,
    query: { from, to, location: location || LOCATION },
  });
}

async function raw(method, path, query, body) {
  const token = await getToken();
  return request(method, path, { token, query, body });
}

module.exports = {
  createClient,
  createAppointment,
  findClientByPhone,
  listServices,
  listEmployees,
  freeTime,
  getSchedule,
  getToken,
  raw,
};
