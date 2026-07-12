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

// ═══ KILL-SWITCH (12.07.2026, приказ Босса: BeautyPro больше НЕТ) ═══
// Салон самостоятельный с 03.07. Вызовы BP из рантайма (веб-запись, Mono,
// waitlist) висели до 15с таймаута НА ПУТИ КЛИЕНТА и только потом продолжали.
// Теперь любой вызов падает МГНОВЕННО с 'bp-disabled' — все call-sites уже
// обрабатывают ошибку как best-effort. Вернуть BP: BEAUTYPRO_ENABLED=1 в env.
const BP_DISABLED = process.env.BEAUTYPRO_ENABLED !== '1';

function request(method, path, { token, body, query } = {}) {
  if (BP_DISABLED) return Promise.reject(new Error('bp-disabled: салон відвʼязаний від BeautyPro (03.07)'));
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
    req.setTimeout(15000, () => req.destroy(new Error('timeout 15s')));
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

// ── Провести визит в BP: чеки на счёт TG-бота + зелёный цвет записи ──
// BP API не умеет связывать sale↔appointment_service (read-only, только их UI),
// поэтому "проведено" = чеки в кассе + color записи (verified 11.06.2026).
const TGBOT_ACCOUNT = process.env.BEAUTYPRO_TGBOT_ACCOUNT || '88dec726-eeae-eee4-2129-4c1a590157a6';
const PAID_COLOR = '#00C853';

async function closeAppointmentAsPaid(appointmentId, paidSum) {
  return withRetry(async () => {
    const token = await getToken();
    const appt = await request('GET', `/appointments/${appointmentId}`, {
      token,
      query: { fields: 'date,state,client,services(start,duration,service,professional,price)' },
    });
    const services = (appt.services || []).filter(s => s.service && s.professional);
    if (!appt.client || !services.length) {
      return { ok: false, reason: 'no-client-or-services' };
    }

    const totalPrice = services.reduce((acc, s) => acc + (Number(s.price) || 0), 0);
    // если оплачено меньше прайса — разница раскидывается скидкой пропорционально
    const discountTotal = Math.max(0, totalPrice - (Number(paidSum) || totalPrice));

    const sales = [];
    let discountLeft = discountTotal;
    for (let i = 0; i < services.length; i++) {
      const s = services[i];
      const price = Number(s.price) || 0;
      // последняя услуга забирает остаток скидки (без потери копеек)
      const disc = (i === services.length - 1)
        ? Math.min(discountLeft, price)
        : Math.min(discountLeft, Math.round(discountTotal * (price / (totalPrice || 1))));
      discountLeft -= disc;
      // start приходит как "15:30" (time-only) — собираем полный timestamp из даты записи
      const calDate = /^\d{2}:\d{2}/.test(s.start)
        ? `${String(appt.date).slice(0, 10)}T${s.start.length === 5 ? s.start + ':00' : s.start}.000Z`
        : s.start;
      const item = {
        service: s.service,
        professional: s.professional,
        appointment: appointmentId,
        calendar_date: calDate,
        duration: s.duration,
      };
      if (disc > 0) {
        item.one_time_discount = { sum: disc, max_percent: 100, reason: 'Оплата через TG-бот (Mono)' };
      }
      // multi-item bug в BP: 2+ items в одном purchase → 500, поэтому по одному
      const sale = await request('POST', '/sales/purchase', {
        token,
        body: {
          location: LOCATION,
          client: appt.client,
          items: [item],
          payments: [{ account: TGBOT_ACCOUNT, sum: price - disc }],
        },
      });
      sales.push(sale);
    }

    // зелёный цвет = визуальный маркер "оплачено" в календаре BP
    await request('PUT', `/appointments/${appointmentId}`, {
      token,
      body: { color: PAID_COLOR },
    });

    return { ok: true, sales: sales.length, total: totalPrice - discountTotal };
  });
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
  closeAppointmentAsPaid,
};
