// ВОРОТА ДЕПЛОЯ — КОНТРАКТЫ ВНЕШНИХ ПОТРЕБИТЕЛЕЙ API (17.09, Босс: «API, которые нельзя ломать»).
//
// КТО СНАРУЖИ ХОДИТ В API (проверено по public/*.html 17.09):
//   book.html    — онлайн-запись клиента:  /api/booking/{catalog,services,masters,slots,status/:token}
//   cabinet.html — кабинет клиента:        /api/cabinet/{request-code,verify,me,visits,orders,loyalty,logout}
//                                          + /api/shop/readiness
//   (loyalty/promotions/my.html зовут ручки, которых в сервере НЕТ — мёртвые страницы, не контракт)
// Бот записи @Svs_beautybot ходит в библиотеки напрямую, не по HTTP — его контракт покрывает БД/щит.
//
// КАК: снимок ФОРМЫ ответа (ключи + типы, рекурсивно) лежит в test/contracts/<name>.json.
// Тест сверяет живой ответ с снимком: пропавший ключ или смена типа = красный щит = деплой стоит.
// Новые ключи разрешены (аддитивно). null в снимке или в ответе = «поле бывает пустым», не ошибка.
// Обновить снимок осознанно: CONTRACTS_UPDATE=1 node --test -r dotenv/config test/api-contracts.test.js
//
// Сервер — отдельный процесс на :3038 поверх QA-базы (см. _qa-server.js), кабинет входит по
// dev-коду 0000 (ALLOW_DEV_LOGIN=1 только у этого тестового процесса; на проде флага нет).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { startQaServer } = require('./_qa-server');

const PORT = Number(process.env.CONTRACTS_TEST_PORT || 3038);
const DIR = path.join(__dirname, 'contracts');
const UPDATE = process.env.CONTRACTS_UPDATE === '1';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PHONE = '+380990000117'; // фикстурный клиент кабинета (QA-база)
const MARK = 'QA-CONTRACT-TEST';

let S, db, cabToken = null;
const F = {};
const skipIf = (t) => { if (!process.env.QA_DB_URL) { t.skip('нет QA_DB_URL'); return true; } return false; };

async function call(method, url, { body, auth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + auth;
  const res = await fetch(S.base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

// форма значения: примитив → тип; массив → форма первого элемента; объект → {ключ: форма}
function shapeOf(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : ['empty'];
  if (typeof v === 'object') {
    if (depth > 6) return 'object';
    const o = {}; for (const k of Object.keys(v).sort()) o[k] = shapeOf(v[k], depth + 1); return o;
  }
  return typeof v;
}
// snapshot ⊆ current: каждый ключ снимка есть в ответе с тем же типом; null с любой стороны = ок
function diff(snap, cur, p = '$') {
  const out = [];
  if (snap === null || cur === null) return out;
  if (Array.isArray(snap)) {
    if (!Array.isArray(cur)) return [`${p}: был массив, стало ${typeof cur}`];
    if (snap[0] === 'empty' || cur[0] === 'empty') return out;
    return diff(snap[0], cur[0], p + '[]');
  }
  if (typeof snap === 'object') {
    if (typeof cur !== 'object' || Array.isArray(cur)) return [`${p}: был объект, стало ${Array.isArray(cur) ? 'массив' : typeof cur}`];
    for (const k of Object.keys(snap)) {
      if (!(k in cur)) { out.push(`${p}.${k}: поле ПРОПАЛО`); continue; }
      out.push(...diff(snap[k], cur[k], `${p}.${k}`));
    }
    return out;
  }
  if (snap !== cur) out.push(`${p}: был ${snap}, стало ${cur}`);
  return out;
}

async function contract(name, method, url, opts = {}) {
  const r = await call(method, url, opts);
  const cur = { status: r.status, body: shapeOf(r.body) };
  const file = path.join(DIR, name + '.json');
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ method, url, ...cur }, null, 2) + '\n');
    return { r, created: true };
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(r.status, snap.status, `${name}: статус был ${snap.status}, стал ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const d = diff(snap.body, cur.body);
  assert.deepStrictEqual(d, [], `${name}: контракт ${method} ${url} сломан для внешних страниц:\n  ` + d.join('\n  '));
  return { r, created: false };
}

before(async () => {
  if (!process.env.QA_DB_URL) return;
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`DELETE FROM clients WHERE phone=$1 AND name=$2`, [PHONE, MARK]).catch(() => {});
  F.client = (await db.query(`INSERT INTO clients (name, phone, tenant_id, source) VALUES ($1,$2,$3,'qa-test') RETURNING id`, [MARK, PHONE, TENANT])).rows[0].id;
  // услуга и мастер для слотов — берём живые из QA (онлайн-запись включена)
  const s = await db.query(`SELECT id FROM services WHERE active IS NOT FALSE AND deleted_at IS NULL AND tenant_id=$1 ORDER BY id LIMIT 1`, [TENANT]);
  F.service = s.rows[0]?.id;
  // в QA нет смен на неделю вперёд → слоты всегда пустые. Свой мастер с онлайн-записью,
  // привязкой к услуге и сменой на завтра 09-18 — чтобы снимок держал форму реального слота
  F.master = (await db.query(
    `INSERT INTO masters (name, active, provides_services, online_booking_enabled, tenant_id)
     VALUES ($1,true,true,true,$2) RETURNING id`, [MARK, TENANT])).rows[0].id;
  await db.query(`INSERT INTO master_services (tenant_id, master_id, service_id, active, source) VALUES ($1,$2,$3,true,'qa-test')`,
    [TENANT, F.master, F.service]);
  await db.query(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, tenant_id)
                  VALUES ($1, CURRENT_DATE + 1, '09:00', '18:00', 'qa-test', $2)`, [F.master, TENANT]);
  S = await startQaServer({ port: PORT, extraEnv: { ALLOW_DEV_LOGIN: '1' } });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  for (const [sql, p] of [
    [`DELETE FROM sms_codes WHERE phone LIKE '%' || $1`, [PHONE.replace(/\D/g, '').slice(-9)]],
    [`DELETE FROM master_schedule_days WHERE master_id=$1 AND source='qa-test'`, [F.master]],
    [`DELETE FROM master_services WHERE master_id=$1 AND source='qa-test'`, [F.master]],
    [`DELETE FROM masters WHERE id=$1 AND name=$2`, [F.master, MARK]],
    [`DELETE FROM sessions WHERE client_id=$1`, [F.client]],
    [`DELETE FROM clients WHERE id=$1`, [F.client]],
  ]) { try { await db.query(sql, p); } catch (e) { console.error('[cleanup]', e.message); } }
  await db.end();
}, { timeout: 30000 });

const tomorrow = () => { const d = new Date(Date.now() + 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d); };

test('контракт book.html: каталог онлайн-записи', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('booking.catalog', 'GET', '/api/booking/catalog');
  assert.strictEqual(r.status, 200);
});
test('контракт book.html: список услуг', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('booking.services', 'GET', '/api/booking/services');
  assert.ok(Array.isArray(r.body) && r.body.length > 0, 'услуги для записи не пустые');
});
test('контракт book.html: список мастеров', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('booking.masters', 'GET', '/api/booking/masters');
  assert.ok(Array.isArray(r.body), 'мастера — массив');
});
test('контракт book.html: слоты (первый из 10 дней, где есть свободное время)', async (t) => { if (skipIf(t)) return;
  // пустой массив — тоже валидный ответ, но снимок с реальным слотом защищает форму слота (start/end/master…)
  let date = tomorrow();
  for (let i = 1; i <= 10; i++) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(Date.now() + i * 86400000));
    const r = await call('GET', `/api/booking/slots?service_id=${F.service}&date=${d}`);
    if (Array.isArray(r.body) && r.body.length) { date = d; break; }
  }
  const { r } = await contract('booking.slots', 'GET', `/api/booking/slots?service_id=${F.service}&date=${date}`);
  if (!r.body.length) t.diagnostic('в QA-базе нет ни одного слота на 10 дней вперёд — снимок формы слота слабый');
});
test('контракт book.html: статус несуществующей брони', async (t) => { if (skipIf(t)) return;
  await contract('booking.status-404', 'GET', '/api/booking/status/no-such-token-qa');
});
test('контракт cabinet.html: readiness магазина', async (t) => { if (skipIf(t)) return;
  await contract('shop.readiness', 'GET', '/api/shop/readiness');
});
test('контракт cabinet.html: без входа — 401 с полем error', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('cabinet.me-unauth', 'GET', '/api/cabinet/me');
  assert.strictEqual(r.status, 401);
});
test('контракт cabinet.html: запрос кода входа', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('cabinet.request-code', 'POST', '/api/cabinet/request-code', { body: { phone: PHONE } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});
test('контракт cabinet.html: подтверждение кода → токен', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('cabinet.verify', 'POST', '/api/cabinet/verify', { body: { phone: PHONE, code: '0000' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  cabToken = r.body.token || r.body.access_token || null;
  assert.ok(cabToken, 'в ответе есть токен: ' + JSON.stringify(r.body).slice(0, 200));
});
test('контракт cabinet.html: профиль', async (t) => { if (skipIf(t)) return;
  const { r } = await contract('cabinet.me', 'GET', '/api/cabinet/me', { auth: cabToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});
test('контракт cabinet.html: визиты', async (t) => { if (skipIf(t)) return;
  await contract('cabinet.visits', 'GET', '/api/cabinet/visits', { auth: cabToken });
});
test('контракт cabinet.html: заказы', async (t) => { if (skipIf(t)) return;
  await contract('cabinet.orders', 'GET', '/api/cabinet/orders', { auth: cabToken });
});
test('контракт cabinet.html: лояльность', async (t) => { if (skipIf(t)) return;
  await contract('cabinet.loyalty', 'GET', '/api/cabinet/loyalty', { auth: cabToken });
});
test('контракт cabinet.html: выход', async (t) => { if (skipIf(t)) return;
  await contract('cabinet.logout', 'POST', '/api/cabinet/logout', { auth: cabToken });
});
