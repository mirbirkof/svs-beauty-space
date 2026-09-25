// [25.09] Босс: «адмін помилково провів оплату карткою, а треба готівкою — дати можливість виправити».
// Проверяем смену способа оплаты на живом сервере поверх песочной базы (как pay-cycle.test.js):
// визит картой → наличные; смешанная оплата по частям; POS-чек из 2 товаров целиком; отказы
// (Mono, закрытая смена, мусорный способ), атомарность; после смены способа отмена оплаты работает.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.PM_TEST_PORT || 3041);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-PM-2509';
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
let db, S; const F = { appts: [], ops: [], shifts: [] };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch (_) {} return { status: res.status, body: j };
};
const ops = (id) => q(`SELECT id, category, amount::float AS amount, method, shift_id, description FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in' ORDER BY id`, [id]);
async function newAppt(price, hour) {
  const r = (await q(`INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
    VALUES ($1,$2,$3, (($4::date + ($7 || ':00')::time) AT TIME ZONE 'Europe/Kyiv'), (($4::date + ($7 || ':00')::time + interval '1 hour') AT TIME ZONE 'Europe/Kyiv'),
    'confirmed', $5, $6, 'qa-test', $8) RETURNING id`, [F.client, F.master, F.service, kyivToday(), price, TENANT, String(hour).padStart(2, '0'), MARK]))[0];
  F.appts.push(r.id); return r.id;
}
const skip = (t) => { if (!QA_URL) { t.skip('нет QA_DB_URL'); return true; } return false; };

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source) VALUES ($1,$2,'qa-test') RETURNING id`, [MARK, TENANT]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  // открытая смена, как в проде (если в песочнице своей нет)
  const open = (await q(`SELECT id FROM cash_shifts WHERE status='open' LIMIT 1`))[0];
  if (open) F.shift = open.id;
  else { F.shift = (await q(`INSERT INTO cash_shifts (opening_cash, notes, status, tenant_id) VALUES (0,$1,'open',$2) RETURNING id`, [MARK, TENANT]))[0].id; F.shifts.push(F.shift); }
  // закрытая смена в прошлом (не сдвигает «последнее закрытие» — closed_at в прошлом)
  F.closed = (await q(`INSERT INTO cash_shifts (opening_cash, notes, status, opened_at, closed_at, tenant_id) VALUES (0,$1,'closed','2026-01-01','2026-01-01 10:00',$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.shifts.push(F.closed);
  S = await startQaServer({ port: PORT });
}, { timeout: 150000 });

after(async () => {
  if (S) { const L = (S.log ? S.log() : '').split('\n').filter(x => /cashbox:|error|Error/.test(x)).slice(-15); if (L.length) console.log('SERVER LOG:\n' + L.join('\n')); S.stop(); } if (!db) return;
  for (const [sql, p] of [
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[])`, [F.appts]],
    [`DELETE FROM cash_operations WHERE id = ANY($1::int[])`, [F.ops]],
    [`DELETE FROM cash_operations WHERE shift_id = ANY($1::int[])`, [F.shifts]],
    [`DELETE FROM audit_log WHERE action='cashbox.method_change' AND meta::text LIKE '%' || $1 || '%'`, ['"ref_id":' + (F.appts[0] || 0)]],
    [`DELETE FROM bonus_transactions WHERE client_id=$1`, [F.client]], [`DELETE FROM bonus_balances WHERE client_id=$1`, [F.client]],
    [`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [F.appts]],
    [`DELETE FROM appointments WHERE id = ANY($1::int[])`, [F.appts]],
    [`DELETE FROM cash_shifts WHERE id = ANY($1::int[])`, [F.shifts]],
    [`DELETE FROM services WHERE id=$1`, [F.service]], [`DELETE FROM masters WHERE id=$1`, [F.master]], [`DELETE FROM clients WHERE id=$1`, [F.client]],
  ]) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', sql.slice(0, 60), e.message); } }
  await db.end();
}, { timeout: 60000 });

test('визит оплачен картой → меняем на готівку: метод, след в описании и журнале, плашка визита', async (t) => {
  if (skip(t)) return;
  F.a1 = await newAppt(1000, 10);
  const p = await api('POST', `/api/schedule/appointments/${F.a1}/pay`, { method: 'card' });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  const l = await api('GET', `/api/cashbox/appointment/${F.a1}/payments`);
  assert.strictEqual(l.status, 200); assert.strictEqual(l.body.items.length, 1);
  assert.deepStrictEqual([l.body.items[0].method, l.body.items[0].editable, l.body.items[0].amount], ['card', true, 1000]);
  const r = await api('POST', '/api/cashbox/operations/method', { ids: [l.body.items[0].id], method: 'cash' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.changed, 1);
  const o = (await ops(F.a1))[0];
  assert.strictEqual(o.method, 'cash'); assert.strictEqual(o.amount, 1000, 'сумма не тронута');
  assert.match(o.description || '', /Картка → Готівка/);
  const a = (await q(`SELECT status, pay_settled_at FROM appointments WHERE id=$1`, [F.a1]))[0];
  assert.strictEqual(a.status, 'done'); assert.ok(a.pay_settled_at, 'визит остаётся оплаченным');
  const au = await q(`SELECT 1 FROM audit_log WHERE action='cashbox.method_change' AND entity_id=$1`, [String(o.id)]);
  assert.strictEqual(au.length, 1, 'запись в журнале действий');
  const j = await api('GET', `/api/schedule/journal?date=${kyivToday()}`);
  assert.ok(JSON.stringify(j.body).includes(`"id":${F.a1}`), 'визит в журнале');
  const find = (n) => { if (!n || typeof n !== 'object') return null; if (Array.isArray(n)) { for (const x of n) { const f = find(x); if (f) return f; } return null; }
    if (Number(n.id) === F.a1 && 'pay_method' in n) return n; for (const k of Object.keys(n)) { const f = find(n[k]); if (f) return f; } return null; };
  assert.strictEqual(find(j.body)?.pay_method, 'cash', 'плашка «Оплачено · Готівка» в журнале');
});

test('тот же способ → ничего не меняется; мусорный способ/mono → 400', async (t) => {
  if (skip(t)) return;
  const id = (await ops(F.a1))[0].id;
  const same = await api('POST', '/api/cashbox/operations/method', { ids: [id], method: 'cash' });
  assert.strictEqual(same.status, 200); assert.strictEqual(same.body.changed, 0);
  for (const m of ['mono', 'bonus', '', "cash'--"]) {
    const r = await api('POST', '/api/cashbox/operations/method', { ids: [id], method: m });
    assert.strictEqual(r.status, 400, m); assert.strictEqual(r.body.error, 'bad-method');
  }
  const none = await api('POST', '/api/cashbox/operations/method', { ids: [], method: 'card' });
  assert.strictEqual(none.status, 400);
  const miss = await api('POST', '/api/cashbox/operations/method', { ids: [2147000000], method: 'card' });
  assert.strictEqual(miss.status, 404);
});

test('смешанная оплата 400 готівка + 600 картка → меняем только карточную часть', async (t) => {
  if (skip(t)) return;
  F.a2 = await newAppt(1000, 12);
  const p = await api('POST', `/api/schedule/appointments/${F.a2}/pay`, { method: 'mixed', mixed_cash: 400, mixed_card: 600 });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  const l = (await api('GET', `/api/cashbox/appointment/${F.a2}/payments`)).body.items;
  assert.strictEqual(l.length, 2);
  const card = l.find(x => x.method === 'card');
  const r = await api('POST', '/api/cashbox/operations/method', { ids: [card.id], method: 'cash' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = await ops(F.a2);
  // две наличные части сливаются в одну (у визита не бывает двух одинаковых оплат)
  assert.deepStrictEqual(after.map(x => [x.method, x.amount]), [['cash', 1000]], 'итог визита не тронут, одна запись');
  assert.match(after[0].description || '', /\+600 ₴ з частини «Картка»/);
  // и обратно: всё на картку
  const back = await api('POST', '/api/cashbox/operations/method', { ids: [after[0].id], method: 'card' });
  assert.strictEqual(back.status, 200);
  assert.deepStrictEqual((await ops(F.a2)).map(x => [x.method, x.amount]), [['card', 1000]]);
  // отмена оплаты после слияния — касса чистая
  const u = await api('POST', `/api/schedule/appointments/${F.a2}/unpay`, {});
  assert.strictEqual(u.status, 200, JSON.stringify(u.body)); assert.strictEqual((await ops(F.a2)).length, 0);
});

test('POS-чек из 2 товаров картой → меняем весь чек на переказ', async (t) => {
  if (skip(t)) return;
  const b = 'pos-qa' + Date.now().toString(36);
  for (const [v, amt] of [[901, 300], [902, 450]]) {
    const r = (await q(`INSERT INTO cash_operations (shift_id, type, category, amount, method, description, ext_ref, tenant_id)
      VALUES ($1,'in','sale_product',$2,'card',$3,$4,$5) RETURNING id`, [F.shift, amt, 'Продаж: ' + MARK, b + ':' + v, TENANT]))[0];
    F.ops.push(r.id);
  }
  const ids = F.ops.slice(-2);
  const r = await api('POST', '/api/cashbox/operations/method', { ids, method: 'transfer' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.changed, 2);
  const rows = await q(`SELECT method, amount::float a FROM cash_operations WHERE id = ANY($1::int[])`, [ids]);
  assert.deepStrictEqual(rows.map(x => x.method), ['transfer', 'transfer']);
});

test('Mono и закрытая смена — отказ; смешанный запрос (можно+нельзя) не меняет НИЧЕГО', async (t) => {
  if (skip(t)) return;
  F.a3 = await newAppt(500, 14);
  const mono = (await q(`INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, ext_ref, tenant_id)
    VALUES ($1,'in','sale_service',500,'mono','appointment',$2,$3,$4) RETURNING id`, [F.shift, F.a3, 'mono:qa:' + Date.now(), TENANT]))[0].id;
  const closed = (await q(`INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, tenant_id, created_at)
    VALUES ($1,'in','sale_service',500,'card','appointment',$2,$3,'2026-01-01 09:00') RETURNING id`, [F.closed, F.a3, TENANT]))[0].id;
  const rm = await api('POST', '/api/cashbox/operations/method', { ids: [mono], method: 'cash' });
  assert.strictEqual(rm.status, 400); assert.strictEqual(rm.body.error, 'system-operation');
  const rc = await api('POST', '/api/cashbox/operations/method', { ids: [closed], method: 'cash' });
  assert.strictEqual(rc.status, 400); assert.strictEqual(rc.body.error, 'shift-closed');
  const okId = (await ops(F.a1))[0].id; // сейчас cash
  const mix = await api('POST', '/api/cashbox/operations/method', { ids: [okId, closed], method: 'card' });
  assert.strictEqual(mix.status, 400);
  assert.strictEqual((await ops(F.a1))[0].method, 'cash', 'атомарно: разрешённая тоже не поменялась');
  const l = (await api('GET', `/api/cashbox/appointment/${F.a3}/payments`)).body.items;
  assert.deepStrictEqual(l.map(x => [x.editable, x.block]).sort(), [[false, 'shift-closed'], [false, 'system-operation']]);
  // не-продажа (расход) — отказ
  const out = (await q(`INSERT INTO cash_operations (shift_id, type, category, amount, method, tenant_id) VALUES ($1,'out','rent',100,'card',$2) RETURNING id`, [F.shift, TENANT]))[0].id;
  F.ops.push(out);
  const ro = await api('POST', '/api/cashbox/operations/method', { ids: [out], method: 'cash' });
  assert.strictEqual(ro.status, 400); assert.strictEqual(ro.body.error, 'not-a-sale');
});

test('после смены способа «Скасувати оплату» (анулювання) работает как раньше', async (t) => {
  if (skip(t)) return;
  const u = await api('POST', `/api/schedule/appointments/${F.a1}/unpay`, {});
  assert.strictEqual(u.status, 200, JSON.stringify(u.body));
  assert.strictEqual((await ops(F.a1)).length, 0, 'приход убран из кассы');
  const a = (await q(`SELECT status, pay_settled_at FROM appointments WHERE id=$1`, [F.a1]))[0];
  assert.strictEqual(a.pay_settled_at, null);
  // перезакрытие нужной формой оплаты
  const p = await api('POST', `/api/schedule/appointments/${F.a1}/pay`, { method: 'cash' });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.deepStrictEqual((await ops(F.a1)).map(x => [x.method, x.amount]), [['cash', 1000]]);
});
