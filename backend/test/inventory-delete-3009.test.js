// Сторож 30.09 (Босс: «власник має видаляти зайві акти інвентаризації, щоб зникли зі списку»).
// 1) Власник видаляє акт у роботі → 200, акта немає ні в списку, ні по id (404); у БД рядок лишився
//    (мʼяке видалення: deleted_at/deleted_by, статус cancelled), рядки акта не стерті.
// 2) Скасований акт теж видаляється; проведений — 409 «проведений акт змінив залишки».
// 3) Не власник (адмін зі stock.manage) — 403 owner-only, can_delete=false у списку.
// 4) Повторне видалення — 404; два одночасні запити — рівно один 200.
// 5) Залишки stock_qty до/після видалення однакові, рухів складу від видалення немає.
// БЕЗПЕКА: окремий сервер (у щиті :3049 — 3037 зайнятий pay-cycle; ручний прогін 30.09 — INVDEL_TEST_PORT=3037) поверх QA_DB_URL (пісочниця), фікстури QA-INV-DEL прибираються в after().
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.INVDEL_TEST_PORT || 3049);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-INV-DEL-3009';
const PID = 'qa-inv-del-' + Date.now().toString(36);
const ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
let db, S, adminUserId;
const F = { vids: [] };

const call = async (token, method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const owner = (m, u, b) => call(S.token, m, u, b);
const admin = (m, u, b) => call(ADMIN_TOKEN, m, u, b);
const q = async (sql, p) => (await db.query(sql, p)).rows;
const stocks = async () => (await q(`SELECT id, stock_qty::float s FROM product_variants WHERE id = ANY($1::int[]) ORDER BY id`, [F.vids]));
const newAudit = async () => {
  const r = await owner('POST', '/api/inventory/audits', { scope: 'spot', scope_filter: { variant_ids: F.vids }, notes: MARK + ' ' + Math.random() });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.audit_id;
};
const listIds = async () => (await owner('GET', '/api/inventory/audits')).body.items.map((a) => a.id);

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await q(`ALTER TABLE inventory_audits ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await q(`ALTER TABLE inventory_audits ADD COLUMN IF NOT EXISTS deleted_by TEXT`);
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,true,$3)`, [PID, MARK + ' товар', TENANT]);
  for (const [vol, st] of [['A', 10], ['B', 5]]) {
    F.vids.push((await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, active, tenant_id)
                          VALUES ($1,$2,150,90,$3,true,$4) RETURNING id`, [PID, vol, st, TENANT]))[0].id);
  }
  // не власник: адмін зі stock.manage (перевизначення прав — не залежить від налаштувань ролі в пісочниці)
  const role = (await q(`SELECT id FROM roles WHERE code='admin' ORDER BY id LIMIT 1`))[0];
  adminUserId = (await q(`INSERT INTO users (display_name, role_id, is_active, permissions_override, tenant_id)
                          VALUES ($1,$2,true,$3::jsonb,$4) RETURNING id`,
                         [MARK + ' адмін', role.id, JSON.stringify(['stock.read', 'stock.manage']), TENANT]))[0].id;
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW() + INTERVAL '1 hour',$4)`,
          [adminUserId, crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex'), MARK, TENANT]);
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
  if (adminUserId) {
    await q(`DELETE FROM user_tokens WHERE user_id=$1`, [adminUserId]);
    await q(`DELETE FROM audit_log WHERE user_id=$1`, [adminUserId]).catch(() => {});
    await q(`DELETE FROM users WHERE id=$1`, [adminUserId]).catch(() => {});
  }
  await db.end();
});

test('власник видаляє акт у роботі: 200, зник зі списку й по id, у БД лишився (мʼяко), залишки ті самі', { skip: !QA_URL }, async () => {
  const id = await newAudit();
  const d = await owner('GET', '/api/inventory/audits/' + id);
  const itemA = d.body.items.find((it) => it.variant_id === F.vids[0]);
  assert.strictEqual((await owner('PATCH', '/api/inventory/items/' + itemA.id, { actual_qty: 3 })).status, 200); // факт −7, не проведено
  const before = await stocks();
  const lst = await owner('GET', '/api/inventory/audits');
  assert.strictEqual(lst.body.can_delete, true, 'власнику кнопка дозволена');
  assert.ok(lst.body.items.some((a) => a.id === id));

  const r = await owner('POST', `/api/inventory/audits/${id}/delete`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.was_status, 'in_progress');
  assert.ok(!(await listIds()).includes(id), 'після видалення акта немає в списку');
  assert.strictEqual((await owner('GET', '/api/inventory/audits/' + id)).status, 404);

  const row = (await q(`SELECT status, deleted_at, deleted_by FROM inventory_audits WHERE id=$1`, [id]))[0];
  assert.ok(row, 'рядок акта фізично лишився');
  assert.strictEqual(row.status, 'cancelled', 'акт у роботі став скасованим у тій самій транзакції');
  assert.ok(row.deleted_at && row.deleted_by);
  assert.strictEqual(Number((await q(`SELECT COUNT(*) n FROM inventory_audit_items WHERE audit_id=$1`, [id]))[0].n), 2, 'рядки акта не стерті');
  assert.deepStrictEqual(await stocks(), before, 'stock_qty до/після видалення однакові');
  assert.strictEqual(Number((await q(`SELECT COUNT(*) n FROM stock_movements WHERE variant_id = ANY($1::int[])`, [F.vids]))[0].n), 0, 'жодного руху складу');
  // видалений акт не можна «оживити»: ні провести, ні внести факт
  assert.strictEqual((await owner('POST', `/api/inventory/audits/${id}/complete`)).status, 400, 'акт скасовано — провести не можна (логіку проведення не чіпали)');
  assert.strictEqual((await owner('PATCH', '/api/inventory/items/' + itemA.id, { actual_qty: 1 })).status, 409);
  assert.deepStrictEqual(await stocks(), before);

  const again = await owner('POST', `/api/inventory/audits/${id}/delete`);
  assert.strictEqual(again.status, 404, 'повторне видалення — 404');
});

test('скасований акт видаляється; проведений — 409; не власник — 403', { skip: !QA_URL }, async () => {
  const c = await newAudit();
  assert.strictEqual((await owner('DELETE', '/api/inventory/audits/' + c)).status, 200); // скасувати
  assert.strictEqual((await admin('POST', `/api/inventory/audits/${c}/delete`)).status, 403, 'адмін не може видаляти');
  const adm = await admin('GET', '/api/inventory/audits');
  assert.strictEqual(adm.status, 200); assert.strictEqual(adm.body.can_delete, false, 'не власнику кнопка не показується');
  const rc = await owner('POST', `/api/inventory/audits/${c}/delete`);
  assert.strictEqual(rc.status, 200); assert.strictEqual(rc.body.was_status, 'cancelled');
  assert.ok(!(await listIds()).includes(c));

  const done = await newAudit();
  const d = await owner('GET', '/api/inventory/audits/' + done);
  assert.strictEqual((await owner('PATCH', '/api/inventory/items/' + d.body.items[0].id, { actual_qty: Number(d.body.items[0].expected_qty) + 1 })).status, 200);
  assert.strictEqual((await owner('POST', `/api/inventory/audits/${done}/complete`)).status, 200);
  const st = await stocks();
  const r = await owner('POST', `/api/inventory/audits/${done}/delete`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.message, /Проведений акт змінив залишки/);
  assert.ok((await listIds()).includes(done), 'проведений акт лишився в списку');
  assert.deepStrictEqual(await stocks(), st);
  assert.strictEqual((await admin('POST', `/api/inventory/audits/${done}/delete`)).status, 403);
});

test('два одночасні видалення = рівно один 200; сміттєвий id — 400', { skip: !QA_URL }, async () => {
  const id = await newAudit();
  const rs = await Promise.all([owner('POST', `/api/inventory/audits/${id}/delete`), owner('POST', `/api/inventory/audits/${id}/delete`)]);
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 404]);
  assert.strictEqual((await owner('POST', '/api/inventory/audits/abc/delete')).status, 400);
});
