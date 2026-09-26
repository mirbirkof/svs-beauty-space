// Сторож P0 26.09 (Босс: «факт в інвентаризації зберігається, але не переноситься в залишки;
// ще — редагувати ціну й зберігати»).
// 1) Проведення акту переносить у залишки ВСІ позиції з розбіжністю (N з N), не підраховані не чіпає.
// 2) Правка факту ПІСЛЯ проведення не губиться (раніше лягала в закритий акт мовчки) і не задвоюється:
//    повтор того ж числа — нуль руху; зміна — лише різниця з уже застосованим.
// 3) Скасований акт: факт не приймається (409), провести не можна (400); проведений — вдруге не можна.
// 4) Ціна зберігається через PATCH варіанта; змінити на 0 / сміття — 400; акт віддає ціну.
// 5) ops/inv-reconcile-2609.js доприменює «загублений» факт у проведеному акті рівно один раз.
// БЕЗПЕКА: окремий сервер :3044 поверх QA_DB_URL (пісочниця), фікстури QA-INV-P0 прибираються в after().
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.INVP0_TEST_PORT || 3044);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-INV-P0-2609';
const PID = 'qa-inv-p0-' + Date.now().toString(36);
let db, S;
const F = { vids: [], audits: [] };

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const q = async (sql, p) => (await db.query(sql, p)).rows;
const stock = async (vid) => Number((await q(`SELECT stock_qty FROM product_variants WHERE id=$1`, [vid]))[0].stock_qty);
const moved = async (vid, aid) => (await q(`SELECT COALESCE(SUM(delta),0)::float s, COUNT(*)::int n FROM stock_movements WHERE variant_id=$1 AND reason='inventory_audit' AND ref_id=$2`, [vid, aid]))[0];
const newAudit = async (vids) => {
  const r = await api('POST', '/api/inventory/audits', { scope: 'spot', scope_filter: { variant_ids: vids }, notes: MARK });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); F.audits.push(r.body.audit_id);
  const d = await api('GET', '/api/inventory/audits/' + r.body.audit_id);
  const byV = Object.fromEntries(d.body.items.map((it) => [it.variant_id, it]));
  return { id: r.body.audit_id, byV, items: d.body.items };
};

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await q(`ALTER TABLE inventory_audit_items ADD COLUMN IF NOT EXISTS applied_qty NUMERIC(12,3)`);
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,true,$3)`, [PID, MARK + ' товар', TENANT]);
  for (const [vol, st] of [['A', 10], ['B', 5], ['C', 8], ['D', 4]]) {
    F.vids.push((await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, active, tenant_id)
                          VALUES ($1,$2,150,90,$3,true,$4) RETURNING id`, [PID, vol, st, TENANT]))[0].id);
  }
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  await q(`DELETE FROM inventory_audit_items WHERE audit_id IN (SELECT id FROM inventory_audits WHERE notes LIKE $1)`, [MARK + '%']);
  await q(`DELETE FROM inventory_audits WHERE notes LIKE $1`, [MARK + '%']);
  await q(`DELETE FROM stock_movements WHERE variant_id = ANY($1::int[])`, [F.vids]);
  await q(`DELETE FROM product_variants WHERE id = ANY($1::int[])`, [F.vids]);
  await q(`DELETE FROM products WHERE id=$1`, [PID]);
  await db.end();
});

test('проведення переносить у залишки всі розбіжності (N з N); правка після проведення — рівно різниця, без задвоєння', { skip: !QA_URL }, async () => {
  const [A, B, C] = F.vids;
  const a = await newAudit([A, B, C]);
  assert.strictEqual(a.items.length, 3);
  assert.ok(a.items.every((it) => Number(it.price) === 150), 'акт віддає поточну ціну варіанта');
  assert.strictEqual((await api('PATCH', '/api/inventory/items/' + a.byV[A].id, { actual_qty: 7 })).status, 200); // −3
  assert.strictEqual((await api('PATCH', '/api/inventory/items/' + a.byV[B].id, { actual_qty: 5 })).status, 200); // 0
  assert.strictEqual(await stock(A), 10, 'до проведення залишок не змінюється');

  const c = await api('POST', `/api/inventory/audits/${a.id}/complete`);
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  assert.strictEqual(c.body.adjusted, 1, 'з розбіжністю одна позиція — вона й перенесена');
  assert.strictEqual(c.body.counted, 2); assert.strictEqual(c.body.total, 3);
  assert.strictEqual(await stock(A), 7); assert.strictEqual(await stock(B), 5); assert.strictEqual(await stock(C), 8, 'не підрахована — не чіпається');
  assert.deepStrictEqual(await moved(A, a.id), { s: -3, n: 1 });

  // факт по C внесли ПІСЛЯ проведення (саме так загубився «BIO HIDRA» в акті №10)
  let p = await api('PATCH', '/api/inventory/items/' + a.byV[C].id, { actual_qty: 10 });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.strictEqual(p.body.applied_to_stock, true); assert.strictEqual(p.body.stock_delta, 2);
  assert.strictEqual(await stock(C), 10, 'правка після проведення дійшла до залишку');
  // повтор того ж числа (Enter ще раз) — нічого нового
  p = await api('PATCH', '/api/inventory/items/' + a.byV[C].id, { actual_qty: 10 });
  assert.strictEqual(p.body.stock_delta, 0);
  assert.strictEqual(await stock(C), 10, 'повтор не задвоює');
  assert.deepStrictEqual(await moved(C, a.id), { s: 2, n: 1 });
  // виправили вже проведену позицію A: 7 → 6 = ще −1, а не −4
  p = await api('PATCH', '/api/inventory/items/' + a.byV[A].id, { actual_qty: 6 });
  assert.strictEqual(p.body.stock_delta, -1);
  assert.strictEqual(await stock(A), 6);
  assert.deepStrictEqual(await moved(A, a.id), { s: -4, n: 2 });
  // паралельні однакові правки — одна корекція
  await Promise.all([1, 2, 3].map(() => api('PATCH', '/api/inventory/items/' + a.byV[B].id, { actual_qty: 3 })));
  assert.strictEqual(await stock(B), 3); assert.deepStrictEqual(await moved(B, a.id), { s: -2, n: 1 });

  assert.strictEqual((await api('POST', `/api/inventory/audits/${a.id}/complete`)).status, 400, 'вдруге провести не можна');
  assert.strictEqual((await api('PATCH', '/api/inventory/items/' + a.byV[A].id, { actual_qty: -1 })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/inventory/items/' + a.byV[A].id, { actual_qty: 'abc' })).status, 400);
  const inv = await q(`SELECT variant_id, applied_qty::float ap FROM inventory_audit_items WHERE audit_id=$1 ORDER BY variant_id`, [a.id]);
  for (const r of inv) assert.strictEqual(r.ap || 0, (await moved(r.variant_id, a.id)).s, 'applied_qty = сумі рухів акту');
});

test('скасований акт: факт не приймається, провести не можна', { skip: !QA_URL }, async () => {
  const D = F.vids[3];
  const a = await newAudit([D]);
  assert.strictEqual((await api('DELETE', '/api/inventory/audits/' + a.id)).status, 200);
  const p = await api('PATCH', '/api/inventory/items/' + a.byV[D].id, { actual_qty: 1 });
  assert.strictEqual(p.status, 409); assert.match(p.body.message, /скасовано/i);
  assert.strictEqual((await api('POST', `/api/inventory/audits/${a.id}/complete`)).status, 400);
  assert.strictEqual(await stock(D), 4);
});

test('ціна: зберігається, 0 і сміття — 400, у журналі було → стало', { skip: !QA_URL }, async () => {
  const [A] = F.vids;
  const r = await api('PATCH', '/api/admin/variants/' + A, { price: 199.5 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(Number(r.body.variant.price), 199.5);
  assert.strictEqual(Number((await q(`SELECT price FROM product_variants WHERE id=$1`, [A]))[0].price), 199.5);
  const w = await api('PATCH', '/api/admin/variants/' + A, { wholesale: 120 });
  assert.strictEqual(Number(w.body.variant.wholesale), 120); assert.strictEqual(Number(w.body.variant.price), 199.5, 'опт не стирає роздріб');
  assert.strictEqual((await api('PATCH', '/api/admin/variants/' + A, { price: 0 })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/admin/variants/' + A, { price: 'abc' })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/admin/variants/' + A, { price: -5 })).status, 400);
  assert.strictEqual(Number((await q(`SELECT price FROM product_variants WHERE id=$1`, [A]))[0].price), 199.5, 'після відмов ціна та сама');
  const log = await q(`SELECT meta FROM audit_log WHERE action='stock.variant.update' AND entity_id=$1 ORDER BY id DESC LIMIT 2`, [A]);
  assert.ok(log.some((l) => Number(l.meta.price) === 199.5 && Number(l.meta.price_old) === 150), 'журнал: 150 → 199.5');
});

test('ops/inv-reconcile-2609.js: «загублений» факт у проведеному акті доприменюється рівно один раз', { skip: !QA_URL }, async () => {
  const D = F.vids[3];
  const a = await newAudit([D]);
  const c = await api('POST', `/api/inventory/audits/${a.id}/complete`);
  assert.strictEqual(c.body.adjusted, 0);
  // стара поведінка: факт ліг у закритий акт напряму, без руху
  await q(`UPDATE inventory_audit_items SET actual_qty=1, counted_at=NOW(), applied_qty=NULL WHERE id=$1`, [a.byV[D].id]);
  const before = await stock(D);
  const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'ops', 'inv-reconcile-2609.js'), '--apply'],
    { env: { ...process.env, DB_URL: QA_URL, INV_EMPTY_DUPES: '0', INV_BACKUP: '/tmp/inv-reconcile-qa-test.json' }, encoding: 'utf8' });
  const out1 = run();
  assert.match(out1, /APPLIED/);
  assert.strictEqual(await stock(D), before - 3, 'різниця 1−4 = −3 застосована');
  run();
  assert.strictEqual(await stock(D), before - 3, 'повторний запуск нічого не задвоює');
  assert.deepStrictEqual(await moved(D, a.id), { s: -3, n: 1 });
});
