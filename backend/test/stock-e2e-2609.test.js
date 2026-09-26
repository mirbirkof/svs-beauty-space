// Сквозна перевірка механіки складу (26.09, Бос: «везде должна быть проработана нормально логика и механика,
// перепроверяй всё»). Один товар проходить увесь шлях, після КОЖНОГО кроку звіряємо залишок і журнал рухів:
//   накладна (прихід) → продаж у касі (POS) → матеріали візиту при «виконано» → списання вручну →
//   продаж магазин→салон (перенос між складами) → акт інвентаризації салону (проведення = корекція + рух) →
//   повторне відкриття акту → акт магазину. Подвійні натискання: накладна, чек POS, «виконано», створення акту,
//   проведення акту — ніде не плодять дублів. Інваріант: сума рухів салону = зміна залишку салону.
// БЕЗПЕКА: окремий сервер на :3047 поверх QA_DB_URL (пісочниця), фікстури з міткою, прибираються в after().
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.STOCKE2E_TEST_PORT || 3047);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const TAG = 'qae2e' + Date.now().toString(36).slice(-6);
const MARK = 'QA-E2E-2609-' + TAG;
let db, S;
const F = { audits: [], storeActs: [], transfers: [], appts: [] };

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const q = async (sql, p) => (await db.query(sql, p)).rows;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const salon = async () => Number((await q(`SELECT stock_qty FROM product_variants WHERE id=$1`, [F.v]))[0].stock_qty);
const store = async () => Number(((await q(`SELECT qty FROM warehouse_stock WHERE variant_id=$1 AND warehouse_id='store'`, [F.v]))[0] || { qty: 0 }).qty);
const moves = async (where = '') => q(`SELECT delta::float d, reason, warehouse_id FROM stock_movements WHERE variant_id=$1 ${where} ORDER BY id`, [F.v]);
// рухи САЛОНУ: без складу або 'salon' (рухи магазину позначені warehouse_id='store')
const salonMovesSum = async () => (await moves(`AND COALESCE(warehouse_id,'salon') <> 'store'`)).reduce((s, m) => s + m.d, 0);
const START = 10;

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  F.pid = TAG + '-prod';
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,true,$3)`, [F.pid, `${TAG} шампунь 250ml`, TENANT]);
  F.v = (await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, unit_ml, active, tenant_id)
                  VALUES ($1,'250ml',100,60,$2,1,true,$3) RETURNING id`, [F.pid, START, TENANT]))[0].id;
  await q(`INSERT INTO warehouse_stock (variant_id, warehouse_id, qty, avg_cost) VALUES ($1,'store',5,60)`, [F.v]);
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source) VALUES ($1,$2,'qa-test') RETURNING id`, [MARK, TENANT]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,500,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.appt = (await q(`INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
                     VALUES ($1,$2,$3, now() - interval '2 hours', now() - interval '1 hour', 'confirmed', 500, $4, 'qa-test', $5) RETURNING id`,
    [F.client, F.master, F.service, TENANT, MARK]))[0].id;
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  const steps = [
    [`DELETE FROM inventory_audit_items WHERE audit_id = ANY($1::int[])`, [F.audits]],
    [`DELETE FROM inventory_audits WHERE id = ANY($1::int[])`, [F.audits]],
    [`DELETE FROM store_inventory_lines WHERE act_id = ANY($1::int[])`, [F.storeActs]],
    [`DELETE FROM store_inventory_acts WHERE id = ANY($1::int[])`, [F.storeActs]],
    [`DELETE FROM internal_transfer_items WHERE transfer_id = ANY($1::int[])`, [F.transfers]],
    [`DELETE FROM internal_transfers WHERE id = ANY($1::int[])`, [F.transfers]],
    [`DELETE FROM cash_operations WHERE ext_ref LIKE $1 OR (ref_type='appointment' AND ref_id=$2)`, [TAG + '%', F.appt]],
    [`DELETE FROM appointment_materials WHERE appointment_id=$1`, [F.appt]],
    [`DELETE FROM appointment_services WHERE appointment_id=$1`, [F.appt]],
    [`DELETE FROM appointments WHERE id=$1`, [F.appt]],
    [`DELETE FROM services WHERE id=$1`, [F.service]],
    [`DELETE FROM masters WHERE id=$1`, [F.master]],
    [`DELETE FROM clients WHERE id=$1`, [F.client]],
    [`DELETE FROM stock_import_docs WHERE filename LIKE $1`, [MARK + '%']],
    [`DELETE FROM stock_movements WHERE variant_id=$1`, [F.v]],
    [`DELETE FROM inventory_audit_items WHERE variant_id=$1`, [F.v]],
    [`DELETE FROM store_inventory_lines WHERE variant_id=$1`, [F.v]],
    [`DELETE FROM warehouse_stock WHERE variant_id=$1`, [F.v]],
    [`DELETE FROM product_variants WHERE id=$1`, [F.v]],
    [`DELETE FROM products WHERE id=$1`, [F.pid]],
  ];
  for (const [sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', sql.slice(0, 60), e.message); } }
  await db.end();
});

test('механіка складу від приходу до інвентаризації: залишок і журнал сходяться на кожному кроці', { skip: !QA_URL, timeout: 120000 }, async () => {
  // 1) НАКЛАДНА: прихід +4; повторне проведення тієї самої накладної — 409, без другого приходу
  const inv = { kind: 'invoice', filename: MARK + '.txt', doc_date: today(), items: [{ name: `${TAG} шампунь 250ml`, variant_id: F.v, qty: 4, price: 60 }] };
  let r = await api('POST', '/api/stock-import/apply', inv);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(await salon(), START + 4, 'накладна: залишок');
  r = await api('POST', '/api/stock-import/apply', inv);
  assert.strictEqual(r.status, 409, 'повторна накладна мала бути відхилена: ' + JSON.stringify(r.body));
  assert.strictEqual(await salon(), START + 4, 'повторна накладна задвоїла прихід');

  // 2) ПРОДАЖ У КАСІ (POS): −2 і рух 'sale'; той самий чек удруге (подвійний клік) — без другого списання
  const sale = { type: 'in', category: 'sale_product', amount: 200, method: 'cash', variant_id: F.v, qty: 2, ext_ref: TAG + ':pos1', allow_no_shift: true, description: MARK };
  r = await api('POST', '/api/cashbox/operations', sale);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('POST', '/api/cashbox/operations', sale);
  assert.strictEqual(r.status, 200); assert.ok(r.body.already, 'другий POST того ж чеку мав повернути already');
  assert.strictEqual(await salon(), START + 2, 'POS: залишок');
  assert.strictEqual((await moves(`AND reason='sale'`)).length, 1, 'POS: має бути рівно один рух продажу');

  // 3) МАТЕРІАЛИ ВІЗИТУ: 3 шт, при «виконано» — списання; повторне «виконано» — без другого списання
  r = await api('POST', `/api/consumables/appointment/${F.appt}`, { variant_id: F.v, qty_used: 3 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('PATCH', `/api/schedule/appointments/${F.appt}`, { status: 'done' });
  assert.ok(r.status < 300, 'виконано: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
  await api('PATCH', `/api/schedule/appointments/${F.appt}`, { status: 'done' });
  assert.strictEqual(await salon(), START - 1, 'матеріали візиту: залишок');
  assert.strictEqual((await moves(`AND reason LIKE 'service:%'`)).length, 1, 'матеріали: має бути рівно один рух списання');

  // 4) СПИСАННЯ вручну −1
  r = await api('POST', `/api/admin/variants/${F.v}/stock`, { qty: -1, note: MARK });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(await salon(), START - 2, 'списання: залишок');

  // 5) МАГАЗИН → САЛОН: 2 шт (склад магазину 5 → 3, салон +2), два рухи з різними складами
  r = await api('POST', '/api/store/transfer', { items: [{ variant_id: F.v, qty: 2 }], notes: MARK });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); F.transfers.push(r.body.transfer_id);
  assert.strictEqual(await store(), 3, 'перенос: склад магазину');
  assert.strictEqual(await salon(), START, 'перенос: склад салону');
  r = await api('POST', '/api/store/transfer', { items: [{ variant_id: F.v, qty: 99 }] });
  assert.strictEqual(r.status, 400, 'продати салону більше, ніж є в магазині, не можна');

  // 6) АКТ САЛОНУ: подвійне «Створити» → той самий акт; факт 7 при обліку 10 → проведення: −3 і рух inventory_audit
  const body = { scope: 'spot', scope_filter: { variant_ids: [F.v] }, notes: MARK };
  const [a1, a2] = await Promise.all([api('POST', '/api/inventory/audits', body), api('POST', '/api/inventory/audits', body)]);
  assert.strictEqual(a1.status, 200, JSON.stringify(a1.body));
  F.audits.push(a1.body.audit_id, a2.body.audit_id);
  assert.strictEqual(a1.body.audit_id, a2.body.audit_id, 'подвійне створення акту дало два акти');
  const aid = a1.body.audit_id;
  r = await api('GET', `/api/inventory/audits/${aid}`);
  const item = r.body.items.find(x => +x.variant_id === +F.v);
  assert.ok(item, 'позиції немає в акті'); assert.strictEqual(Number(item.expected_qty), START);
  r = await api('PATCH', `/api/inventory/items/${item.id}`, { actual_qty: 7 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const [c1, c2] = await Promise.all([api('POST', `/api/inventory/audits/${aid}/complete`, {}), api('POST', `/api/inventory/audits/${aid}/complete`, {})]);
  assert.deepStrictEqual([c1.status, c2.status].sort(), [200, 400], `подвійне проведення: ${c1.status}/${c2.status}`);
  assert.strictEqual(await salon(), 7, 'акт: залишок після проведення');
  assert.strictEqual((await moves(`AND reason='inventory_audit'`)).reduce((s, m) => s + m.d, 0), -3, 'акт: рух корекції');
  // повторне відкриття: акт проведений, факт на місці
  r = await api('GET', `/api/inventory/audits/${aid}`);
  assert.strictEqual(r.body.audit.status, 'completed');
  assert.strictEqual(Number(r.body.items.find(x => +x.variant_id === +F.v).actual_qty), 7);

  // ІНВАРІАНТ: журнал рухів салону = зміна залишку салону
  assert.strictEqual(+(await salonMovesSum()).toFixed(3), (await salon()) - START, 'сума рухів салону не дорівнює зміні залишку');

  // 7) АКТ МАГАЗИНУ: факт 2 при обліку 3 → після закриття склад магазину 2 і рух store:inventory_close −1
  r = await api('POST', '/api/store/inventory/acts', { note: MARK });
  if (r.status === 409) { console.log('[e2e] у пісочниці вже відкритий акт магазину — крок 7 пропущено, щоб не чіпати чужий акт'); return; }
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const sa = r.body.act.id; F.storeActs.push(sa);
  r = await api('POST', '/api/store/inventory/acts', { note: MARK });
  assert.strictEqual(r.status, 409, 'другий відкритий акт магазину');
  r = await api('PUT', `/api/store/inventory/acts/${sa}/line`, { variant_id: F.v, counted_qty: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await api('POST', `/api/store/inventory/acts/${sa}/close`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(await store(), 2, 'акт магазину: залишок');
  r = await api('POST', `/api/store/inventory/acts/${sa}/close`);
  assert.strictEqual(r.status, 400, 'повторне закриття акту магазину');
  const storeSum = (await moves(`AND warehouse_id='store'`)).reduce((s, m) => s + m.d, 0);
  assert.strictEqual(storeSum, 2 - 5, 'журнал магазину не дорівнює зміні залишку магазину');
});
