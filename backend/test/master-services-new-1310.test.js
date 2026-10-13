// Сторож 13.10 (Босс: «у майстрів зайві послуги, що до них не відносяться; додав нового майстра — у послугах каша;
// продумай логіку додавання від початку до кінця»). КОРІНЬ: майстер без звʼязок master_services → пікери журналу показували
// ВЕСЬ каталог салону. Тепер:
// 1) новий майстер «Майстер манікюру» → звʼязки лише з категорії «Нігті» (source auto_specialty), відповідь каже скільки;
// 2) спеціальність без категорії (Адміністратор) → 0 звʼязок, пропозиції нема (нічого не вигадуємо);
// 3) наявний майстер без звʼязок → by-master віддає suggested (спеціальність), bulk додає одним кліком, повтор — 0 дублів;
// 4) майстер зі звʼязками → suggested=null, автопривʼязка нічого не додає; bulk без входу → 401.
// БЕЗПЕКА: окремий сервер :3052 поверх QA_DB_URL (пісочниця), фікстури з міткою, прибираються в after.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');
const { autoLinkNew } = require('../lib/master-svc-suggest');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.MSVC_TEST_PORT || 3052);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-MSVC-1310';
let db, S; const F = { svc: {}, masters: [] };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const call = async (token, method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {} return { status: res.status, body: json };
};
const owner = (m, u, b) => call(S.token, m, u, b);
const phone = () => '+38099' + String(Math.floor(1e6 + Math.random() * 8e6));
const catsOf = async (mid) => (await q(`SELECT DISTINCT s.category FROM master_services ms JOIN services s ON s.id=ms.service_id WHERE ms.master_id=$1`, [mid])).map(r => r.category).sort();

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  for (const [k, cat] of [['n1', 'Нігті'], ['n2', 'Нігті'], ['l1', 'Вії'], ['l2', 'Брови та вії'], ['h1', 'Волосся']]) {
    F.svc[k] = (await q(`INSERT INTO services (name, category, price, duration_min, active, tenant_id) VALUES ($1,$2,500,60,true,$3) RETURNING id`, [`${MARK} ${k}`, cat, TENANT]))[0].id;
  }
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop(); if (!db) return;
  const ids = F.masters.filter(Boolean);
  if (ids.length) {
    await q(`DELETE FROM master_services WHERE master_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM employee_history WHERE employee_id = ANY($1::int[])`, [ids]).catch(() => {});
    await q(`DELETE FROM masters WHERE id = ANY($1::int[])`, [ids]).catch(() => {});
  }
  await q(`DELETE FROM master_services WHERE service_id = ANY($1::int[])`, [Object.values(F.svc)]);
  await q(`DELETE FROM services WHERE id = ANY($1::int[])`, [Object.values(F.svc)]);
  await db.end();
});

test('новий майстер манікюру: лише послуги «Нігті», звʼязки auto_specialty, у відповіді кількість', { skip: !QA_URL }, async () => {
  const r = await owner('POST', '/api/employees', { name: `${MARK} Манікюр`, phone: phone(), specialty: 'Майстер манікюру', allow_namesake: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const id = r.body.employee.id; F.masters.push(id);
  assert.ok(r.body.services_added >= 2, 'додано ' + r.body.services_added);
  assert.deepStrictEqual(r.body.services_categories, ['Нігті']);
  assert.deepStrictEqual(await catsOf(id), ['Нігті'], 'жодної чужої категорії');
  const links = await q(`SELECT service_id, source FROM master_services WHERE master_id=$1`, [id]);
  assert.ok(links.some(l => l.service_id === F.svc.n1) && links.some(l => l.service_id === F.svc.n2) && !links.some(l => l.service_id === F.svc.h1));
  assert.ok(links.every(l => l.source === 'auto_specialty'));
  const g = await owner('GET', '/api/master-services/by-master/' + id);
  assert.strictEqual(g.status, 200); assert.strictEqual(g.body.suggested, null, 'звʼязки є — пропозиції нема');
  assert.strictEqual((await autoLinkNew(db, id)).added, 0, 'повторна автопривʼязка нічого не додає');
});

test('адміністратор: спеціальність без категорії — 0 звʼязок і порожня пропозиція', { skip: !QA_URL }, async () => {
  const r = await owner('POST', '/api/employees', { name: `${MARK} Адмін`, phone: phone(), specialty: 'Адміністратор', allow_namesake: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const id = r.body.employee.id; F.masters.push(id);
  assert.strictEqual(r.body.services_added, 0);
  const g = await owner('GET', '/api/master-services/by-master/' + id);
  assert.strictEqual(g.body.items.length, 0); assert.ok(g.body.suggested && g.body.suggested.service_ids.length === 0 && g.body.suggested.source === 'none');
});

test('наявний майстер без звʼязок (лешмейкер): пропозиція → «Додати» одним кліком, повтор без дублів, без входу 401', { skip: !QA_URL }, async () => {
  const id = (await q(`INSERT INTO masters (name, specialty, active, tenant_id) VALUES ($1,'Лешмейкер',true,$2) RETURNING id`, [`${MARK} Леш`, TENANT]))[0].id; F.masters.push(id);
  const g = await owner('GET', '/api/master-services/by-master/' + id);
  assert.strictEqual(g.status, 200); const sg = g.body.suggested;
  assert.ok(sg && sg.service_ids.includes(F.svc.l1) && sg.service_ids.includes(F.svc.l2) && !sg.service_ids.includes(F.svc.n1) && !sg.service_ids.includes(F.svc.h1), JSON.stringify(sg && sg.groups));
  const noAuth = await call(null, 'POST', '/api/master-services/bulk', { master_id: id, service_ids: sg.service_ids });
  assert.strictEqual(noAuth.status, 401);
  const b = await owner('POST', '/api/master-services/bulk', { master_id: id, service_ids: sg.service_ids });
  assert.strictEqual(b.status, 200, JSON.stringify(b.body)); assert.strictEqual(b.body.added, sg.service_ids.length);
  const b2 = await owner('POST', '/api/master-services/bulk', { master_id: id, service_ids: sg.service_ids });
  assert.strictEqual(b2.body.added, 0, 'повтор — без дублів');
  const g2 = await owner('GET', '/api/master-services/by-master/' + id);
  assert.strictEqual(g2.body.items.length, sg.service_ids.length); assert.strictEqual(g2.body.suggested, null);
  assert.deepStrictEqual((await catsOf(id)).filter(c => !['Вії', 'Брови та вії'].includes(c)), [], 'лише вії/брови');
  const bad = await owner('POST', '/api/master-services/bulk', { master_id: 99999999, service_ids: [F.svc.l1] });
  assert.strictEqual(bad.status, 404);
});
