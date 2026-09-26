// Сторож дублей товаров (26.09, Босс: «Почисти склади від повторюваних позицій, можливо вони
// заважають при завантаженні й відображенні нових товарів»).
//
// КОРІНЬ: загрузка накладної не впізнавала вже існуючий товар, якщо назва написана інакше
// («EXTREMO 6,04 60 г» проти картки «extremo 6.04 · за грам») → «створити новий» → друга картка;
// «Новий товар» в адмінці створював картку з унікальним id, не перевіряючи назву; приймання
// магазину створювало друге однакове фасування. Майстри обирали то одну картку, то іншу →
// прихід на одній, списання на іншій, склад розповзався.
// Ловимо: розбір накладної знаходить існуючий товар при різному написанні; create:true НЕ створює
// дубль (прихід на існуючий); два однаково схожі товари → рядок «неоднозначно, оберіть товар»;
// «6/04» не чіпляє інший тон «04»; адмінка: такий самий товар → 409, те саме фасування → 409;
// початковий залишок має рух складу; акт інвентаризації не бере вимкнених карток.
//
// БЕЗПЕКА: окремий сервер на :3043 поверх QA_DB_URL (пісочниця), фікстури з міткою qadups, прибираються в after().
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.STOCKDUPS_TEST_PORT || 3043);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const TAG = 'qadups' + Date.now().toString(36).slice(-5); // унікальне «слово бренду/серії» у назвах
const FILE = `QA-DUPS-2609-${TAG}.txt`;
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
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const productsLike = async () => (await q(`SELECT id FROM products WHERE name ILIKE $1 AND active IS NOT FALSE`, [`%${TAG}%`])).length;

async function mk(pid, name, volume, stock, active = true) {
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,$3,$4)`, [pid, name, active, TENANT]);
  return (await q(`INSERT INTO product_variants (product_id, volume, price, stock_qty, unit_ml, active, tenant_id)
                   VALUES ($1,$2,12,$3,1,$4,$5) RETURNING id`, [pid, volume, stock, active, TENANT]))[0].id;
}

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  F.v604 = await mk(`${TAG}-6-04`, `${TAG} 6.04`, 'за грам', 74);        // «той самий» товар
  F.v04 = await mk(`${TAG}-04`, `${TAG} 04`, 'за грам', 20);             // інший тон — не плутати з 6/04
  F.vA1 = await mk(`${TAG}-7-1-a`, `${TAG} 7.1`, 'за грам', 5);          // два однакові → неоднозначно
  F.vA2 = await mk(`${TAG}-7-1-b`, `${TAG.toUpperCase()} 7.1 `, 'г', 0);
  F.vOff = await mk(`${TAG}-off`, `${TAG} off 9.9`, 'за грам', 3, false); // вимкнена картка
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  if (F.audits.length) await q(`DELETE FROM inventory_audits WHERE id = ANY($1::int[])`, [F.audits]);
  const pids = (await q(`SELECT id FROM products WHERE id LIKE $1 OR name ILIKE $2`, [`${TAG}%`, `%${TAG}%`])).map(r => r.id);
  const vids = (await q(`SELECT id FROM product_variants WHERE product_id = ANY($1::text[])`, [pids])).map(r => r.id);
  await q(`DELETE FROM inventory_audit_items WHERE variant_id = ANY($1::int[])`, [vids]);
  await q(`DELETE FROM stock_movements WHERE variant_id = ANY($1::int[])`, [vids]);
  await q(`DELETE FROM product_variants WHERE id = ANY($1::int[])`, [vids]);
  await q(`DELETE FROM products WHERE id = ANY($1::text[])`, [pids]);
  await q(`DELETE FROM stock_import_docs WHERE filename LIKE $1`, [`QA-DUPS-2609-${TAG}%`]);
  await db.end();
});

test('накладна: «EXTREMO 6,04 60 г» / «Фарба … 6.04 60мл» / «6/04» знаходять існуючу картку, а не інший тон', { skip: !QA_URL }, async () => {
  const text = [`${TAG.toUpperCase()} 6,04 60 г\t2\t120.00`, `Фарба ${TAG} 6.04 60мл\t1\t120.00`, `${TAG} 6/04\t1\t120.00`].join('\n');
  const r = await api('POST', '/api/stock-import/parse', { text });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.items.length, 3);
  for (const it of r.body.items) {
    assert.ok(it.matches.length, `«${it.name}»: збігів немає — інтерфейс запропонує «створити новий» (так і народжувались дублі)`);
    assert.strictEqual(it.matches[0].variant_id, F.v604, `«${it.name}»: перший кандидат ${it.matches[0].label}, а має бути «${TAG} 6.04»`);
    assert.ok(!it.matches.some(m => m.variant_id === F.v04), `«${it.name}»: запропоновано ІНШИЙ тон «${TAG} 04»`);
  }
});

test('накладна з create:true на вже існуючий товар — прихід на нього, нова картка НЕ створюється', { skip: !QA_URL }, async () => {
  const before = await productsLike();
  const r = await api('POST', '/api/stock-import/apply', {
    kind: 'invoice', filename: FILE, doc_date: today(), unit: 'ml',
    items: [{ name: `${TAG.toUpperCase()} 6,04 60 г`, qty: 60, price: 120, create: true, unit: 'ml' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.created, 0, 'створено нову картку-дубль');
  assert.strictEqual(r.body.received, 1);
  assert.strictEqual(await productsLike(), before, 'кількість товарів змінилась — зʼявився дубль');
  const v = await q(`SELECT stock_qty::float s FROM product_variants WHERE id=$1`, [F.v604]);
  assert.strictEqual(v[0].s, 74 + 60, 'прихід мав лягти на існуючу картку');
});

test('два однаково схожі товари → рядок «неоднозначно, оберіть товар», нічого не створено і не проведено', { skip: !QA_URL }, async () => {
  const p = await api('POST', '/api/stock-import/parse', { text: `${TAG} 7,1\t3\t100.00` });
  assert.strictEqual(p.status, 200);
  assert.ok(p.body.items[0].ambiguous, 'розбір має позначити рядок як неоднозначний: ' + JSON.stringify(p.body.items[0]));
  const before = await productsLike();
  const r = await api('POST', '/api/stock-import/apply', {
    kind: 'invoice', filename: FILE + '-amb', doc_date: today(),
    items: [{ name: `${TAG} 7,1`, qty: 3, price: 100, create: true, unit: 'ml' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.created, 0);
  assert.strictEqual(r.body.received, 0);
  assert.strictEqual(r.body.lines[0].status, 'ambiguous', JSON.stringify(r.body.lines));
  assert.match(r.body.lines[0].why, /неоднозначно, оберіть товар/);
  assert.strictEqual(await productsLike(), before);
});

test('прайс: рядок на існуючий товар не створює другу картку', { skip: !QA_URL }, async () => {
  const before = await productsLike();
  const r = await api('POST', '/api/stock-import/apply', { kind: 'pricelist', filename: FILE + '-pl', items: [{ name: `Фарба ${TAG} 6.04`, price: 130 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.created, 0, JSON.stringify(r.body.lines));
  assert.strictEqual(await productsLike(), before);
});

test('адмінка «Новий товар»: така сама назва → 409 з існуючим; те саме фасування → 409; початковий залишок = рух складу', { skip: !QA_URL }, async () => {
  const d = await api('POST', '/api/admin/products', { id: `${TAG}-dup-${Date.now().toString(36)}`, name: `  ${TAG.toUpperCase()}  6.04 ` });
  assert.strictEqual(d.status, 409, 'створено дубль товару: ' + JSON.stringify(d.body));
  assert.strictEqual(d.body.error, 'duplicate-product');
  assert.strictEqual(d.body.existing[0].variant_id, F.v604);

  const vd = await api('POST', `/api/admin/products/${encodeURIComponent(`${TAG}-6-04`)}/variants`, { volume: ' ЗА ГРАМ', price: 12 });
  assert.strictEqual(vd.status, 409, 'створено друге однакове фасування: ' + JSON.stringify(vd.body));
  assert.strictEqual(vd.body.variant.id, F.v604);

  const np = await api('POST', '/api/admin/products', { id: `${TAG}-new`, name: `${TAG} new 11.1` });
  assert.strictEqual(np.status, 201, JSON.stringify(np.body));
  const nv = await api('POST', `/api/admin/products/${TAG}-new/variants`, { volume: '100ml', price: 50, stock_qty: 4 });
  assert.strictEqual(nv.status, 201, JSON.stringify(nv.body));
  const mv = await q(`SELECT delta::float d, reason FROM stock_movements WHERE variant_id=$1`, [nv.body.variant.id]);
  assert.deepStrictEqual(mv, [{ d: 4, reason: 'adjustment' }], 'початковий залишок без руху складу — склад розійдеться з історією');
});

test('акт інвентаризації не бере вимкнених карток', { skip: !QA_URL }, async () => {
  const r = await api('POST', '/api/inventory/audits', { scope: 'spot', scope_filter: { variant_ids: [F.v604, F.vOff] }, notes: 'QA-DUPS-2609' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  F.audits.push(r.body.audit_id);
  const items = await q(`SELECT variant_id FROM inventory_audit_items WHERE audit_id=$1`, [r.body.audit_id]);
  assert.deepStrictEqual(items.map(i => i.variant_id), [F.v604], 'у акт потрапила вимкнена картка');
});
