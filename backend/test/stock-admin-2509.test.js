// Сторож двух жалоб администратора (25.09, Босс: «Исправь все и перепроверь»).
//
// 1) «Акт інвентаризації створений, але не можемо відкрити його, щоб заповнити».
//    Акт открывался под списком актов за краем окна → админ жал «Створити» снова → в проде 6 дублей.
//    Ловим: двойной клик (два параллельных POST) = ОДИН акт; акт открывается и в него пишется факт.
// 2) «Змінюю ціну та кількість товару → Зберегти → Збережено, але нічого не змінюється».
//    Главная кнопка карточки сохраняла только шапку товара, цена/остаток живут в варианте.
//    Ловим: PATCH варианта реально меняет цену и остаток; остаток меняется через движение склада
//    ('adjustment' = новое − старое), без движения при неизменном остатке; мусор → 400;
//    и что главная кнопка карточки снова шлёт варианты (статическая проверка index.html).
//
// БЕЗОПАСНОСТЬ: отдельный сервер на :3039 поверх QA_DB_URL (песочница), фикстуры помечены
// QA-STOCK-2509 и удаляются в after(). Нет QA_DB_URL → пропуск.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.STOCK2509_TEST_PORT || 3039);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-STOCK-2509';
const PID = 'qa-stock-2509-' + Date.now().toString(36);
let db, S;
const F = { audits: [] };

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const q = async (sql, p) => (await db.query(sql, p)).rows;
const moves = (vid) => q(`SELECT reason, delta::float AS delta FROM stock_movements WHERE variant_id=$1 ORDER BY id`, [vid]);

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,true,$3)`, [PID, MARK + ' товар', TENANT]);
  F.vid = (await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, active, tenant_id)
                    VALUES ($1,'стандарт',100,60,5,true,$2) RETURNING id`, [PID, TENANT]))[0].id;
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  if (F.audits.length) await q(`DELETE FROM inventory_audits WHERE id = ANY($1::int[])`, [F.audits]);
  await q(`DELETE FROM inventory_audits WHERE notes = $1`, [MARK]);
  await q(`DELETE FROM stock_movements WHERE variant_id=$1`, [F.vid]);
  await q(`DELETE FROM product_variants WHERE id=$1`, [F.vid]);
  await q(`DELETE FROM products WHERE id=$1`, [PID]);
  await db.end();
});

test('інвентаризація: подвійний клік «Створити акт» дає ОДИН акт, і він відкривається для заповнення', { skip: !QA_URL }, async () => {
  const body = { scope: 'spot', scope_filter: { variant_ids: [F.vid] }, notes: MARK };
  const [a, b] = await Promise.all([api('POST', '/api/inventory/audits', body), api('POST', '/api/inventory/audits', body)]);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body)); assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  F.audits.push(a.body.audit_id, b.body.audit_id);
  assert.strictEqual(a.body.audit_id, b.body.audit_id, 'два запити подвійного кліку створили РІЗНІ акти — дубль');
  assert.ok(a.body.reused || b.body.reused, 'другий запит має повернути вже створений акт (reused)');
  const n = await q(`SELECT count(*)::int n FROM inventory_audits WHERE notes=$1`, [MARK]);
  assert.strictEqual(n[0].n, 1, 'у базі рівно один акт');

  const d = await api('GET', '/api/inventory/audits/' + a.body.audit_id);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.audit.status, 'in_progress');
  assert.strictEqual(d.body.items.length, 1, 'позиції акту наповнені (одним запитом)');
  assert.strictEqual(Number(d.body.items[0].expected_qty), 5);
  assert.strictEqual(Number(d.body.items[0].cost_per_unit), 60, 'собівартість позиції перенесена як раніше');

  const it = await api('PATCH', '/api/inventory/items/' + d.body.items[0].id, { actual_qty: 4, reason: 'miscount' });
  assert.strictEqual(it.status, 200);
  const d2 = await api('GET', '/api/inventory/audits/' + a.body.audit_id);
  assert.strictEqual(Number(d2.body.items[0].actual_qty), 4, 'факт записався в акт');

  // інший обсяг (повна інвентаризація) — НЕ дубль, дедуп не повинен його ковтати: перевіряємо лише
  // що дедуп дивиться на обсяг, через інший фільтр того ж scope
  const other = await api('POST', '/api/inventory/audits', { scope: 'spot', scope_filter: { variant_ids: [F.vid, -1] }, notes: MARK });
  F.audits.push(other.body.audit_id);
  assert.notStrictEqual(other.body.audit_id, a.body.audit_id, 'акт з іншим обсягом — окремий акт');

  const c = await api('DELETE', '/api/inventory/audits/' + a.body.audit_id);
  assert.strictEqual(c.status, 200);
});

test('товар: зміна ціни й кількості справді зберігається, кількість — через рух складу', { skip: !QA_URL }, async () => {
  const r = await api('PATCH', '/api/admin/variants/' + F.vid, { price: 123.5, stock_qty: 8, volume: 'стандарт', active: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const g = await api('GET', '/api/admin/products/' + PID);
  assert.strictEqual(Number(g.body.variants[0].price), 123.5, 'ціна змінилась на сервері');
  assert.strictEqual(Number(g.body.variants[0].stock_qty), 8, 'кількість змінилась на сервері');
  let m = await moves(F.vid);
  assert.deepStrictEqual(m.filter(x => x.reason === 'adjustment').map(x => x.delta), [3], 'рух корекції +3 (8 − 5)');

  // та сама кількість ще раз (кнопка «Зберегти» без змін залишку) — нового руху немає
  const r2 = await api('PATCH', '/api/admin/variants/' + F.vid, { price: 130, stock_qty: 8 });
  assert.strictEqual(r2.status, 200);
  m = await moves(F.vid);
  assert.strictEqual(m.filter(x => x.reason === 'adjustment').length, 1, 'без зміни залишку рух не пишеться');

  // зменшення — від'ємна корекція, залишок = рівно введене число
  await api('PATCH', '/api/admin/variants/' + F.vid, { stock_qty: 2.5 });
  const v = (await q(`SELECT stock_qty::float s FROM product_variants WHERE id=$1`, [F.vid]))[0];
  assert.strictEqual(v.s, 2.5);
  m = await moves(F.vid);
  assert.deepStrictEqual(m.filter(x => x.reason === 'adjustment').map(x => x.delta), [3, -5.5]);

  // сміття не записується мовчки
  const bad = await api('PATCH', '/api/admin/variants/' + F.vid, { stock_qty: -4 });
  assert.strictEqual(bad.status, 400, 'відʼємний залишок відхиляється');
  const bad2 = await api('PATCH', '/api/admin/variants/' + F.vid, { price: 'abc' });
  assert.strictEqual(bad2.status, 400, 'нечислова ціна відхиляється');
  assert.strictEqual((await api('PATCH', '/api/admin/variants/999999999', { price: 1 })).status, 404);
});

test('екран: головна кнопка картки товару зберігає і варіанти; акт відкривається у видиму область', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');
  const fn = idx.slice(idx.indexOf('async function saveProdCard('), idx.indexOf('// Звʼязка собівартості за грам'));
  assert.ok(fn.includes("/api/admin/variants/"), 'saveProdCard не шле варіанти — ціна/залишок знову «не зберігаються»');
  assert.ok(fn.includes('openProduct(_prod.id'), 'після збереження картка перечитується з сервера');
  const ex = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'crm-extra.html'), 'utf8');
  const oa = ex.slice(ex.indexOf('async function openAudit('), ex.indexOf('async function saveItem('));
  assert.ok(oa.includes('scrollIntoView'), 'openAudit має прокручувати акт у видиму область');
  const ca = ex.slice(ex.indexOf('async function createAudit('), ex.indexOf('async function openAudit('));
  assert.ok(/disabled\s*=\s*true/.test(ca), 'кнопка «Створити акт» блокується на час запиту');
  assert.ok(!/function init\(\)\{\s*setRange\(30\)/.test(ex), 'init не тягне Звіти при відкритті Інвентаризації');
});
