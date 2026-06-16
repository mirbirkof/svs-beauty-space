/*
 * BeautyPro Appointments Sync — наполнение локального зеркала записей
 *
 * Причина создания: таблица appointments была пуста (beautypro_id был INTEGER,
 * BP отдаёт GUID). Из-за этого reminders / repeat-visits работали вхолостую.
 *
 * Endpoints (все под sync.write):
 *   POST /api/sync/v2/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD — синк записей
 *   POST /api/sync/v2/services                                    — синк каталога услуг
 *   GET  /api/sync/v2/appointments/status                         — статистика зеркала
 *
 * Cron: каждые 30 мин подтягивает окно [-1 день .. +14 дней].
 */
const express = require('express');
const https = require('https');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();

const APP_ID = process.env.BEAUTYPRO_ID_KEY;
const SECRET = process.env.BEAUTYPRO_SECRET_KEY;
const DATABASE_CODE = process.env.BEAUTYPRO_DATABASE_CODE || '664684';
const HOST = 'api.aihelps.com';

let cachedToken = null;
let tokenExpiry = 0;

function httpsRequest(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const req = https.request({ hostname: HOST, path: '/v1' + path, method, headers, timeout: 20000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else {
          const err = new Error(`BeautyPro ${res.statusCode}: ${buf.slice(0, 300)}`);
          err.status = res.statusCode;
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

// BP инвалидирует старые токены при выдаче новых (/auth/database) →
// кэш может умереть до tokenExpiry. На 401 сбрасываем и повторяем 1 раз.
function invalidateToken() { cachedToken = null; tokenExpiry = 0; }

async function withAuthRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status === 401) { invalidateToken(); return fn(); }
    throw e;
  }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!APP_ID || !SECRET) throw new Error('BeautyPro keys missing in env');
  const path = `/auth/database?application_id=${encodeURIComponent(APP_ID)}` +
    `&application_secret=${encodeURIComponent(SECRET)}&database_code=${encodeURIComponent(DATABASE_CODE)}`;
  const r = await httpsRequest('GET', path);
  if (!r || !r.access_token) throw new Error('No token in BP response');
  cachedToken = r.access_token;
  tokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
  return cachedToken;
}

// BP state → локальный статус (схема: booked|confirmed|done|cancelled|noshow)
function mapState(s) {
  switch (String(s || '').toLowerCase()) {
    case 'confirmed': return 'confirmed';
    case 'done': case 'completed': case 'paid': return 'done';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'missed': case 'noshow': case 'no_show': return 'noshow';
    default: return 'booked'; // created/new/прочее
  }
}

// BP price бывает числом или объектом {locationGuid: price} → нормализуем в число
function numPrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    const vals = Object.values(v).map(Number).filter((x) => !isNaN(x));
    return vals.length ? vals[0] : null;
  }
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// минуты от полуночи → 'YYYY-MM-DD HH:MM'; BP допускает start >= 24:00 (за полночь) → перенос на след. день
function fmtLocal(date, mins) {
  let d = new Date(date + 'T00:00:00Z');
  d = new Date(d.getTime() + mins * 60000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// "2026-06-01" + "10:00" + duration → {startsLocal, endsLocal} строки 'YYYY-MM-DD HH:MM' (Kyiv)
function calcWindow(date, services) {
  let minStart = null, maxEnd = null;
  for (const s of services || []) {
    if (!s.start) continue;
    const [h, m] = s.start.split(':').map(Number);
    const startMin = h * 60 + m;
    const endMin = startMin + (Number(s.duration) || 0);
    if (minStart === null || startMin < minStart) minStart = startMin;
    if (maxEnd === null || endMin > maxEnd) maxEnd = endMin;
  }
  if (minStart === null) { minStart = 0; maxEnd = 0; }
  return { startsLocal: fmtLocal(date, minStart), endsLocal: fmtLocal(date, Math.max(maxEnd, minStart)) };
}

async function syncServicesCatalog() {
  const pool = getPool();
  const token = await getToken();
  const list = await httpsRequest('GET', `/services?fields=${encodeURIComponent('name,duration,price,category')}&archive=false`, { token });
  const items = Array.isArray(list) ? list : (list && list.data) || [];
  let upserted = 0;
  for (const s of items) {
    if (!s.id || !s.name) continue;
    const cat = (s.category && s.category.name) || (typeof s.category === 'string' ? s.category : null);
    const ex = await pool.query('SELECT id FROM services WHERE beautypro_id = $1', [s.id]);
    if (ex.rows.length) {
      await pool.query('UPDATE services SET name=$1, category=$2, duration_min=$3, price=$4 WHERE beautypro_id=$5',
        [s.name, cat, s.duration || null, numPrice(s.price) ?? 0, s.id]);
    } else {
      await pool.query('INSERT INTO services (name, category, duration_min, price, beautypro_id, active) VALUES ($1,$2,$3,$4,$5,TRUE)',
        [s.name, cat, s.duration || null, numPrice(s.price) ?? 0, s.id]);
    }
    upserted++;
  }
  return { total: items.length, upserted };
}

// Резолв мастера по BP-GUID: сперва прямой beautypro_id, затем алиас
// (один человек может иметь несколько BP-профилей, см. master_bp_aliases).
async function resolveMasterId(pool, guid) {
  if (!guid) return null;
  const m = await pool.query('SELECT id FROM masters WHERE beautypro_id = $1 LIMIT 1', [guid]);
  if (m.rows[0]) return m.rows[0].id;
  const a = await pool.query('SELECT master_id FROM master_bp_aliases WHERE beautypro_id = $1 LIMIT 1', [guid]);
  return a.rows[0]?.master_id || null;
}

async function syncAppointments(from, to) {
  const pool = getPool();
  const token = await getToken();
  const fields = encodeURIComponent('date,client,location,state,services(start,service,professional,duration,price)');
  const list = await httpsRequest('GET', `/appointments?fields=${fields}&from=${from}&to=${to}`, { token });
  const items = Array.isArray(list) ? list : (list && list.data) || [];

  let created = 0, updated = 0, unlinkedClients = 0;
  for (const a of items) {
    if (!a.id || !a.date) continue;
    const services = a.services || [];
    const { startsLocal, endsLocal } = calcWindow(a.date, services);
    const status = mapState(a.state);
    const totalPrice = services.reduce((s, x) => s + (numPrice(x.price) || 0), 0);

    // линковка client / master / первая услуга по beautypro_id
    const cl = a.client ? await pool.query('SELECT id FROM clients WHERE beautypro_id = $1', [a.client]) : { rows: [] };
    if (a.client && !cl.rows.length) unlinkedClients++;
    const firstSvc = services[0] || {};
    const firstMasterId = await resolveMasterId(pool, firstSvc.professional);
    const sv = firstSvc.service ? await pool.query('SELECT id FROM services WHERE beautypro_id = $1', [firstSvc.service]) : { rows: [] };

    const ex = await pool.query('SELECT id FROM appointments WHERE beautypro_id = $1', [a.id]);
    let apptId;
    if (ex.rows.length) {
      apptId = ex.rows[0].id;
      await pool.query(
        `UPDATE appointments SET client_id=$1, master_id=$2, service_id=$3,
           starts_at=($4::timestamp AT TIME ZONE 'Europe/Kyiv'),
           ends_at=($5::timestamp AT TIME ZONE 'Europe/Kyiv'),
           status=$6, bp_state=$7, price=$8, bp_client=$9, synced_at=NOW(), updated_at=NOW()
         WHERE id=$10`,
        [cl.rows[0]?.id || null, firstMasterId, sv.rows[0]?.id || null,
         startsLocal, endsLocal, status, a.state || null, totalPrice || null, a.client || null, apptId]
      );
      updated++;
    } else {
      const ins = await pool.query(
        `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, bp_state, price, source, beautypro_id, bp_client, synced_at)
         VALUES ($1,$2,$3,($4::timestamp AT TIME ZONE 'Europe/Kyiv'),($5::timestamp AT TIME ZONE 'Europe/Kyiv'),$6,$7,$8,'beautypro',$9,$10,NOW())
         RETURNING id`,
        [cl.rows[0]?.id || null, firstMasterId, sv.rows[0]?.id || null,
         startsLocal, endsLocal, status, a.state || null, totalPrice || null, a.id, a.client || null]
      );
      apptId = ins.rows[0].id;
      created++;
    }

    // мульти-услуги: полная перезапись строк услуг записи
    await pool.query('DELETE FROM appointment_services WHERE appointment_id = $1', [apptId]);
    for (const s of services) {
      const svcRow = s.service ? await pool.query('SELECT id FROM services WHERE beautypro_id = $1', [s.service]) : { rows: [] };
      const svcMasterId = await resolveMasterId(pool, s.professional);
      let startLocal = startsLocal;
      if (s.start) {
        const [h, m] = s.start.split(':').map(Number);
        startLocal = fmtLocal(a.date, h * 60 + m); // h может быть >= 24 (за полночь)
      }
      // ON CONFLICT: услуга могла переехать в другую запись в BP (uq_appt_services_bp) — переносим строку
      await pool.query(
        `INSERT INTO appointment_services (appointment_id, service_id, master_id, beautypro_id, starts_at, duration_min, price)
         VALUES ($1,$2,$3,$4,($5::timestamp AT TIME ZONE 'Europe/Kyiv'),$6,$7)
         ON CONFLICT (beautypro_id) WHERE beautypro_id IS NOT NULL DO UPDATE SET
           appointment_id=EXCLUDED.appointment_id, service_id=EXCLUDED.service_id, master_id=EXCLUDED.master_id,
           starts_at=EXCLUDED.starts_at, duration_min=EXCLUDED.duration_min, price=EXCLUDED.price`,
        [apptId, svcRow.rows[0]?.id || null, svcMasterId, s.id || null,
         startLocal, Number(s.duration) || null, Number(s.price) || null]
      );
    }
  }
  return { fetched: items.length, created, updated, unlinked_clients: unlinkedClients };
}

// ── Графік майстрів BP (/schedule) → master_schedule_days ───────────────
// /employees.worktime порожній, тож реальний графік беремо з /schedule по даті.
// "HH:MM" з ISO-таймстемпу worktime (BP віддає у локальному часі салону).
function hhmmFromIso(iso) {
  if (!iso) return null;
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function syncSchedules(from, to) {
  const pool = getPool();
  const token = await getToken();
  const LOCATION = process.env.BEAUTYPRO_LOCATION_ID || '88deba79-2b95-c6e0-9eb9-658d4d8ea59c';
  const r = await httpsRequest('GET', `/schedule?from=${from}&to=${to}&location=${encodeURIComponent(LOCATION)}`, { token });
  const cols = (r && (r.columns || r.data)) || [];
  let upserted = 0, skipped = 0;
  for (const col of cols) {
    const masterId = await resolveMasterId(pool, col.professional);
    if (!masterId) { skipped++; continue; }
    const date = String(col.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
    const wt = Array.isArray(col.worktime) && col.worktime.length ? col.worktime : null;
    // мінімальний start і максимальний end за день (об'єднуємо вікна)
    let start = null, end = null;
    if (wt) {
      for (const w of wt) {
        const s = hhmmFromIso(w.start), e = hhmmFromIso(w.end);
        if (s && (!start || s < start)) start = s;
        if (e && (!end || e > end)) end = e;
      }
    }
    await pool.query(
      `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
       VALUES ($1,$2,$3,$4,'beautypro',NOW())
       ON CONFLICT (master_id, work_date) DO UPDATE SET
         start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, synced_at=NOW()
       WHERE master_schedule_days.source <> 'manual'`,
      [masterId, date, start, end]
    );
    upserted++;
  }
  return { columns: cols.length, upserted, skipped };
}

// ── Продажи BP → касса (cash_operations) ───────────────────────────────
// BP-кошельки → способ оплаты. Безнал = банковская карта, остальное = готівка.
const BP_CARD_ACCOUNTS = new Set(['88de9f80-b486-7c3d-2721-6e895eccd818']);
function saleMethod(payments) {
  if (!Array.isArray(payments) || !payments.length) return 'cash';
  const main = payments.slice().sort((a, b) => (Number(b.sum) || 0) - (Number(a.sum) || 0))[0];
  return BP_CARD_ACCOUNTS.has(main.account) ? 'card' : 'cash';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /sales нестабилен: поле `appointment` роняет 502/500, тяжёлые окна тоже.
// Тянем по одному дню, без appointment, с ретраями.
async function fetchSalesDay(token, day) {
  const nd = new Date(day + 'T00:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1);
  const next = nd.toISOString().slice(0, 10);
  const fields = encodeURIComponent('sale_date,calendar_date,type,sum,cancel,payments,professional_name,name,client');
  const path = `/sales?fields=${fields}&sale_date_from=${day}&sale_date_to=${next}` +
    `&location=${encodeURIComponent(process.env.BEAUTYPRO_LOCATION_ID || '88de9f7c-c225-02e0-597c-7a296e9d6499')}&limit=1000`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await httpsRequest('GET', path, { token });
      return Array.isArray(r) ? r : (r && r.data) || [];
    } catch (e) {
      if (e.status >= 500 && i < 4) { await sleep(700 * (i + 1)); continue; }
      throw e;
    }
  }
  return [];
}

// Проводит продажи BP в кассу за период [from..to] (включительно).
// Идемпотентно: ext_ref = sale.id, ON CONFLICT DO NOTHING.
// Под каждый день — закрытая смена 'BeautyPro YYYY-MM-DD'.
async function syncSales(from, to) {
  const pool = getPool();
  const token = await getToken();
  // имя мастера → id (для привязки операции)
  const mres = await pool.query('SELECT id, name FROM masters');
  const mmap = new Map(mres.rows.map((r) => [String(r.name).trim(), r.id]));
  // Алиасы: в /sales BeautyPro мастер может фигурировать под другим именем,
  // чем в карточке. Иначе продажи падают в "ничьи" (master_id=null).
  // 'Перукар Світлана' = та же людина, що 'Скібенко Світлана'.
  const NAME_ALIASES = { 'Перукар Світлана': 'Скібенко Світлана' };
  for (const [alias, real] of Object.entries(NAME_ALIASES)) {
    const id = mmap.get(real);
    if (id && !mmap.has(alias)) mmap.set(alias, id);
  }

  let posted = 0, skipped = 0, shifts = 0;
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1))
    days.push(d.toISOString().slice(0, 10));

  for (const day of days) {
    const recs = (await fetchSalesDay(token, day)).filter(
      (s) => !s.cancel && (s.type === 'Service' || s.type === 'Product') && (Number(s.sum) || 0) > 0);
    if (!recs.length) continue;
    recs.sort((a, b) => new Date(a.sale_date) - new Date(b.sale_date));
    const cashSum = recs.filter((s) => saleMethod(s.payments) === 'cash').reduce((a, s) => a + Number(s.sum), 0);

    // смена дня
    let sh = await pool.query('SELECT id FROM cash_shifts WHERE notes = $1 LIMIT 1', ['BeautyPro ' + day]);
    let shiftId;
    if (sh.rows[0]) shiftId = sh.rows[0].id;
    else {
      const ins = await pool.query(
        `INSERT INTO cash_shifts (opened_at, closed_at, opening_cash, closing_cash, status, notes)
         VALUES ($1,$2,0,$3,'closed',$4) RETURNING id`,
        [recs[0].sale_date, recs[recs.length - 1].sale_date, cashSum, 'BeautyPro ' + day]);
      shiftId = ins.rows[0].id; shifts++;
    }

    for (const s of recs) {
      const masterId = s.professional_name ? (mmap.get(String(s.professional_name).trim()) || null) : null;
      const bpClient = s.client ? String(s.client) : null;
      const bpCalendar = s.calendar_date || null; // час запису в BP (для матчингу з appointments)
      // ON CONFLICT DO UPDATE: бэкфиллим bp_client/bp_calendar у вже проведених продажів (раніше їх не зберігали)
      const r = await pool.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, master_id, description, created_at, ext_ref, bp_client, bp_calendar)
         VALUES ($1,'in',$2,$3,$4,'bp_sale',$5,$6,$7,$8,$9,$10)
         ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO UPDATE SET
           bp_client=COALESCE(EXCLUDED.bp_client, cash_operations.bp_client),
           bp_calendar=COALESCE(EXCLUDED.bp_calendar, cash_operations.bp_calendar)
         RETURNING (xmax = 0) AS inserted`,
        [shiftId, s.type === 'Service' ? 'sale_service' : 'sale_product', Number(s.sum),
         saleMethod(s.payments), masterId, s.name || null, s.sale_date, s.id, bpClient, bpCalendar]);
      if (r.rows[0]?.inserted) posted++; else skipped++;
    }
  }
  return { posted, skipped, shifts };
}

// ── Детальні продажі товарів BP (/sales type=Product) → salon_product_sales ──
// Кожна позиція окремим рядком (name+quantity+sum). Fuzzy-match до salon_stock.
async function fetchProductSalesDay(token, day) {
  const nd = new Date(day + 'T00:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1);
  const next = nd.toISOString().slice(0, 10);
  const fields = encodeURIComponent('sale_date,type,sum,quantity,cancel,professional_name,name,client');
  const path = `/sales?fields=${fields}&sale_date_from=${day}&sale_date_to=${next}` +
    `&location=${encodeURIComponent(process.env.BEAUTYPRO_LOCATION_ID || '88deba79-2b95-c6e0-9eb9-658d4d8ea59c')}&limit=1000`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await httpsRequest('GET', path, { token });
      return Array.isArray(r) ? r : (r && r.data) || [];
    } catch (e) {
      if (e.status >= 500 && i < 4) { await sleep(700 * (i + 1)); continue; }
      throw e;
    }
  }
  return [];
}

// Пошук позиції складу за назвою: точний (нормалізований) → частковий ILIKE
async function matchStock(pool, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  let r = await pool.query(`SELECT id FROM salon_stock WHERE lower(trim(name)) = lower($1) LIMIT 1`, [n]);
  if (r.rows[0]) return r.rows[0].id;
  r = await pool.query(`SELECT id FROM salon_stock WHERE name ILIKE $1 OR $2 ILIKE ('%'||name||'%') ORDER BY length(name) DESC LIMIT 1`, ['%' + n + '%', n]);
  return r.rows[0]?.id || null;
}

async function syncProductSales(from, to) {
  const pool = getPool();
  const token = await getToken();
  const mres = await pool.query('SELECT id, name FROM masters');
  const mmap = new Map(mres.rows.map((r) => [String(r.name).trim(), r.id]));
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1))
    days.push(d.toISOString().slice(0, 10));

  // кеш резолву GUID клієнта BP → локальний clients.id (через beautypro_id)
  const clientCache = new Map();
  async function resolveClientId(guid) {
    if (!guid) return null;
    if (clientCache.has(guid)) return clientCache.get(guid);
    const cr = await pool.query('SELECT id FROM clients WHERE beautypro_id = $1 LIMIT 1', [guid]);
    const id = cr.rows[0]?.id || null;
    clientCache.set(guid, id);
    return id;
  }

  let posted = 0, skipped = 0, matched = 0, linked = 0;
  for (const day of days) {
    const recs = (await fetchProductSalesDay(token, day)).filter(
      (s) => !s.cancel && s.type === 'Product' && (Number(s.sum) || 0) > 0);
    for (const s of recs) {
      const qty = Number(s.quantity) || 1;
      const total = Number(s.sum) || 0;
      const masterId = s.professional_name ? (mmap.get(String(s.professional_name).trim()) || null) : null;
      const stockId = await matchStock(pool, s.name);
      if (stockId) matched++;
      const bpClient = s.client ? String(s.client) : null;
      const clientId = await resolveClientId(bpClient);
      if (clientId) linked++;
      const r = await pool.query(
        `INSERT INTO salon_product_sales (ext_ref, sale_date, product_name, qty, total_price, unit_price, master_id, master_name, stock_id, matched, bp_client, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (ext_ref) DO UPDATE SET
           product_name=EXCLUDED.product_name, qty=EXCLUDED.qty, total_price=EXCLUDED.total_price,
           unit_price=EXCLUDED.unit_price, master_id=EXCLUDED.master_id, master_name=EXCLUDED.master_name,
           stock_id=EXCLUDED.stock_id, matched=EXCLUDED.matched,
           bp_client=COALESCE(EXCLUDED.bp_client, salon_product_sales.bp_client),
           client_id=COALESCE(EXCLUDED.client_id, salon_product_sales.client_id)
         RETURNING (xmax = 0) AS inserted`,
        [s.id, s.sale_date, s.name || 'Товар', qty, total, qty ? total / qty : total, masterId, s.professional_name || null, stockId, !!stockId, bpClient, clientId]
      );
      if (r.rows[0]?.inserted) posted++; else skipped++;
    }
  }
  return { posted, updated: skipped, matched, linked };
}

// Backfill клиентов BP→local: для записей без client_id тянем клиента из BP и создаём карточку
async function backfillClients(limit = 500) {
  const pool = getPool();
  const token = await getToken();
  const distinct = await pool.query(
    `SELECT DISTINCT bp_client FROM appointments WHERE client_id IS NULL AND bp_client IS NOT NULL LIMIT $1`, [limit]);
  let createdC = 0, linked = 0, failed = 0;
  for (const row of distinct.rows) {
    const guid = row.bp_client;
    try {
      // вдруг уже есть локально (появился после прошлого прогона)
      let local = await pool.query('SELECT id FROM clients WHERE beautypro_id = $1', [guid]);
      if (!local.rows.length) {
        const bp = await httpsRequest('GET', `/clients/${guid}?fields=${encodeURIComponent('name,firstname,lastname,phone,email,birthday')}`, { token });
        const name = bp.name || [bp.firstname, bp.lastname].filter(Boolean).join(' ') || 'Клієнт BP';
        const phone = Array.isArray(bp.phone) ? (bp.phone[0] || null) : (bp.phone || null);
        const digits = phone ? String(phone).replace(/\D/g, '') : null;
        // канонический украинский формат: 380 + последние 9 цифр (исключает дубли 380… vs 0…)
        const last9 = digits && digits.length >= 9 ? digits.slice(-9) : null;
        const phoneNorm = last9 ? ('380' + last9) : digits;
        const email = (bp.email && String(bp.email).trim()) || null; // пустые строки бьются об UNIQUE(email)
        if (last9) {
          // защитимся от дубля по телефону — сравниваем по последним 9 цифрам
          const byPhone = await pool.query('SELECT id FROM clients WHERE right(regexp_replace(phone, \'\\D\', \'\', \'g\'), 9) = $1 LIMIT 1', [last9]);
          if (byPhone.rows.length) {
            await pool.query('UPDATE clients SET beautypro_id = $1 WHERE id = $2', [guid, byPhone.rows[0].id]);
            local = byPhone;
          }
        }
        if (!local.rows.length && email) {
          const byEmail = await pool.query('SELECT id FROM clients WHERE email = $1 LIMIT 1', [email]);
          if (byEmail.rows.length) {
            await pool.query('UPDATE clients SET beautypro_id = $1 WHERE id = $2', [guid, byEmail.rows[0].id]);
            local = byEmail;
          }
        }
        if (!local.rows.length) {
          local = await pool.query(
            `INSERT INTO clients (name, phone, email, birthday, source, beautypro_id) VALUES ($1,$2,$3,$4,'beautypro',$5) RETURNING id`,
            [name, phoneNorm, email, bp.birthday || null, guid]);
          createdC++;
        }
      }
      const r = await pool.query('UPDATE appointments SET client_id = $1 WHERE bp_client = $2 AND client_id IS NULL', [local.rows[0].id, guid]);
      linked += r.rowCount;
    } catch (e) {
      failed++;
      if (failed <= 3) console.error('[bp-appt-sync] backfill err', guid, e.message.slice(0, 120));
    }
  }
  return { candidates: distinct.rows.length, clients_created: createdC, appointments_linked: linked, failed };
}

// ===== ROUTES =====

router.post('/v2/clients-backfill', requirePerm('sync.write'), async (req, res) => {
  try { res.json({ ok: true, ...(await withAuthRetry(() => backfillClients(Number(req.query.limit) || 500))) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.post('/v2/services', requirePerm('sync.write'), async (req, res) => {
  try { res.json({ ok: true, ...(await withAuthRetry(syncServicesCatalog)) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.post('/v2/appointments', requirePerm('sync.write'), async (req, res) => {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = req.query.from || iso(new Date(today.getTime() - 30 * 864e5));
  const to = req.query.to || iso(new Date(today.getTime() + 60 * 864e5));
  try { res.json({ ok: true, from, to, ...(await withAuthRetry(() => syncAppointments(from, to))) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.post('/v2/product-sales', requirePerm('sync.write'), async (req, res) => {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = req.query.from || iso(new Date(today.getTime() - 30 * 864e5));
  const to = req.query.to || iso(today);
  try { res.json({ ok: true, from, to, ...(await withAuthRetry(() => syncProductSales(from, to))) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.post('/v2/schedules', requirePerm('sync.write'), async (req, res) => {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = req.query.from || iso(today);
  const to = req.query.to || iso(new Date(today.getTime() + 30 * 864e5));
  try { res.json({ ok: true, from, to, ...(await withAuthRetry(() => syncSchedules(from, to))) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.post('/v2/sales', requirePerm('sync.write'), async (req, res) => {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = req.query.from || iso(new Date(today.getTime() - 3 * 864e5));
  const to = req.query.to || iso(today);
  try { res.json({ ok: true, from, to, ...(await withAuthRetry(() => syncSales(from, to))) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

router.get('/v2/appointments/status', requirePerm('sync.write'), async (req, res) => {
  try {
    const pool = getPool();
    const a = await pool.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE starts_at > NOW())::int upcoming,
        count(*) FILTER (WHERE client_id IS NULL)::int unlinked,
        max(synced_at) last_sync FROM appointments`);
    const s = await pool.query('SELECT count(*)::int c FROM appointment_services');
    res.json({ ok: true, appointments: a.rows[0], appointment_services: s.rows[0].c });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== CRON: автономна синхронізація BeautyPro → наша CRM =====
// Працює на сервері постійно, незалежно від агента/чату.
//   FAST (кожні 5 хв)  — те, що має бачитись "одразу": записи, оплати/каса, нові клієнти.
//   SLOW (кожні 30 хв) — важче й менш термінове: графік майстрів (30 днів), детальні продажі товарів.
let fastRef = null, slowRef = null, fastBusy = false, slowBusy = false;

// FAST: запис / оплата / новий клієнт — головне для Боса.
async function fastTick() {
  if (fastBusy) return;            // не накладати прогони, якщо попередній ще йде
  fastBusy = true;
  try {
    const iso = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    // 1) записи у вікні [-1 .. +14 днів] — нові/змінені бронювання
    const r = await withAuthRetry(() => syncAppointments(iso(new Date(now.getTime() - 864e5)), iso(new Date(now.getTime() + 14 * 864e5))));
    if (r.created || r.updated) console.log(`[bp-appt-sync] +${r.created} new, ~${r.updated} upd`);
    // 2) нові клієнти, що зʼявились з цих записів (ще не злінковані) — створюємо/лінкуємо
    const bc = await withAuthRetry(() => backfillClients(500));
    if (bc.clients_created || bc.appointments_linked) console.log(`[bp-appt-sync] клієнти: +${bc.clients_created} нових, ${bc.appointments_linked} лінк`);
    // 3) продажі в касу за останні 3 дні — тримаємо касу/оплати синхронними з BP
    const s = await withAuthRetry(() => syncSales(iso(new Date(now.getTime() - 3 * 864e5)), iso(now)));
    if (s.posted) console.log(`[bp-appt-sync] каса: +${s.posted} продажів, ${s.shifts} змін`);
  } catch (e) {
    console.error('[bp-appt-sync] fast cron error:', e.message);
  } finally {
    fastBusy = false;
  }
}

// SLOW: графік майстрів + позиційні продажі товарів (важче, не критично по часу).
async function slowTick() {
  if (slowBusy) return;
  slowBusy = true;
  try {
    const iso = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    const sc = await withAuthRetry(() => syncSchedules(iso(now), iso(new Date(now.getTime() + 30 * 864e5))));
    if (sc.upserted) console.log(`[bp-appt-sync] графік: ${sc.upserted} днів-майстрів`);
    const ps = await withAuthRetry(() => syncProductSales(iso(new Date(now.getTime() - 3 * 864e5)), iso(now)));
    if (ps.posted) console.log(`[bp-appt-sync] товари: +${ps.posted} позицій (${ps.matched} матч)`);
  } catch (e) {
    console.error('[bp-appt-sync] slow cron error:', e.message);
  } finally {
    slowBusy = false;
  }
}

function startCron() {
  if (fastRef) return;
  if (!process.env.BEAUTYPRO_ID_KEY || !process.env.BEAUTYPRO_SECRET_KEY) {
    console.warn('[bp-appt-sync] cron NOT started — BeautyPro keys missing in env');
    return;
  }
  setTimeout(fastTick, 20 * 1000);        // перший швидкий прогон через 20с після старту
  setTimeout(slowTick, 90 * 1000);        // перший повільний — через 90с (не одночасно з fast)
  fastRef = setInterval(fastTick, 5 * 60 * 1000);    // кожні 5 хв
  slowRef = setInterval(slowTick, 30 * 60 * 1000);   // кожні 30 хв
  fastRef.unref(); slowRef.unref();
  console.log('[bp-appt-sync] cron started (fast=5min: appts+clients+sales, slow=30min: schedules+products)');
}
startCron();

module.exports = router;
module.exports.syncAppointments = syncAppointments;
module.exports.backfillClients = backfillClients;
module.exports.syncSales = syncSales;
module.exports.syncSchedules = syncSchedules;
module.exports.syncProductSales = syncProductSales;
module.exports.syncServicesCatalog = syncServicesCatalog;
