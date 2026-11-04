// Лояльність навколо оплаченого візиту (Босс 04.11, loyalty-0411). QA-пісочниця (QA_DB_URL), окремий сервер :3067.
//  • кешбек: база = фактично сплачено (після знижки), майстер-клієнт → без кешбеку, звільнений → звичайний клієнт;
//  • бонус майстру по 0.5% за кожну умову (повернення / перезапис у день візиту / оцінка ≥5) → максимум 1.5%,
//    на клієнтську картку майстра (знайдена за телефоном і привʼязана), ідемпотентно, unpay → сторно;
//  • оцінка зірками в мініапі: лише оплачений візит, змінити 24 год, далі — 409; 1–3⭐ → тихе сповіщення;
//  • кабінет мініапу (/my) не віддає сум витрат (price / spent / total).
// Фікстури помічені QA-LOY-TEST і прибираються в after().
require('dotenv').config();
const QA_URL = process.env.QA_DB_URL;
// Бібліотеку visit-loyalty викликаємо і з тесту (закриття 24-год вікна оцінки) — ТІЛЬКИ поверх QA-бази.
if (QA_URL) { process.env.DATABASE_URL = QA_URL; process.env.DATABASE_URL_APP = QA_URL; }
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');
const { sign } = require('../lib/tg-initdata');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.LOYALTY_TEST_PORT || 3067);
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = 'QA-LOY-TEST';
const BOT = '7000000002:QA-' + crypto.randomBytes(10).toString('hex');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rnd9 = () => String(Math.floor(1e8 + Math.random() * 8.99e8)).slice(0, 9);

let db, S, VL;
const F = { appts: [], clients: [], masters: [] };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const skipIf = (t) => { if (!QA_URL) { t.skip('нема QA_DB_URL'); return true; } return false; };

async function admin(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function mini(method, url, body) {
  const init = sign({ auth_date: Math.floor(Date.now() / 1000), query_id: 'AAq' + F.uid, user: { id: F.uid, first_name: 'QA Лоял' } }, BOT);
  const res = await fetch(BASE + '/api/miniapp' + url, { method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function client(name, phone9, tg = null) {
  const id = (await q(`INSERT INTO clients (name, phone, telegram_id, tenant_id, source) VALUES ($1,$2,$3,$4,'qa-test') RETURNING id`,
    [name, phone9 ? '380' + phone9 : null, tg, TENANT]))[0].id;
  F.clients.push(id); return id;
}
async function master(name, phone9, active = true) {
  const id = (await q(`INSERT INTO masters (name, phone, active, provides_services, tenant_id) VALUES ($1,$2,$3,true,$4) RETURNING id`,
    [name, phone9 ? '+380' + phone9 : null, active, TENANT]))[0].id;
  F.masters.push(id); return id;
}
// візит: dayShift — зсув дня від сьогодні (Київ), paid — одразу оплачений у минулому (без каси)
async function visit(clientId, masterId, { dayShift = 0, hour = 10, price = 1000, paid = false } = {}) {
  const id = (await q(
    `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes, pay_settled_at)
     VALUES ($1,$2,$3, ((((now() AT TIME ZONE 'Europe/Kyiv')::date + $4::int) + make_time($5,0,0)) AT TIME ZONE 'Europe/Kyiv'),
             ((((now() AT TIME ZONE 'Europe/Kyiv')::date + $4::int) + make_time($5+1,0,0)) AT TIME ZONE 'Europe/Kyiv'),
             $6, $7, $8, 'qa-test', $9, $10) RETURNING id`,
    [clientId, masterId, F.service, dayShift, hour, paid ? 'done' : 'confirmed', price, TENANT, MARK, paid ? new Date(Date.now() - 86400e3) : null]))[0].id;
  F.appts.push(id); return id;
}
const rewards = (apptId) => q(`SELECT condition, status, percent::float, check_amount::float, amount::float, master_client_id
                                  FROM master_loyalty_rewards WHERE appointment_id=$1 ORDER BY condition`, [apptId]);
const bal = async (cid) => Number((await q(`SELECT COALESCE(balance,0)::float b FROM bonus_balances WHERE client_id=$1`, [cid]))[0]?.b || 0);
const topPct = async () => Number((await q(
  `SELECT percent::float p FROM bonus_rules WHERE is_active AND trigger_event='payment' AND COALESCE(category,'all')='all'
    ORDER BY priority DESC, id LIMIT 1`))[0]?.p || 0);

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // сервер першим — він накочує міграції (317 master_loyalty_rewards)
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  for (let i = 0; i < 90; i++) {
    const ok = (await q(`SELECT to_regclass('public.master_loyalty_rewards') t,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='pay_bonus_base') c`))[0];
    if (ok.t && ok.c) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  VL = require('../lib/visit-loyalty');
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.mPhone = rnd9();
  F.master = await master(MARK + ' майстер', F.mPhone);
  F.masterCard = await client(MARK + ' майстер-як-клієнт', F.mPhone);          // клієнтська картка майстра (за телефоном)
  F.uid = 7710000000 + Math.floor(Math.random() * 9999999);
  F.client = await client(MARK + ' клієнт', rnd9(), F.uid);
  F.prev = await visit(F.client, F.master, { dayShift: -10, paid: true, price: 500 });     // → «повернення»
  F.appt = await visit(F.client, F.master, { dayShift: 0, hour: 8, price: 1000 });        // візит, що оплачуємо
  F.next = await visit(F.client, F.master, { dayShift: 14, hour: 11, price: 1000 });      // створений сьогодні → «перезапис»
}, { timeout: 180000 });

after(async () => {
  if (S) S.stop();
  try { if (VL) await require('../db-pg').getPool().end(); } catch (_) {}
  if (!db) return;
  const ids = F.appts, cl = F.clients;
  const steps = [
    [`DELETE FROM master_loyalty_rewards WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM visit_ratings WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM bonus_transactions WHERE client_id = ANY($1::int[])`, [cl]],
    [`DELETE FROM bonus_balances WHERE client_id = ANY($1::int[])`, [cl]],
    [`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]],
    [`DELETE FROM services WHERE id=$1`, [F.service]],
    [`DELETE FROM masters WHERE id = ANY($1::int[])`, [F.masters]],
    [`DELETE FROM clients WHERE id = ANY($1::int[])`, [cl]],
    [`DELETE FROM tasks WHERE title ILIKE '%' || $1 || '%'`, [MARK]],
  ];
  for (const [sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', sql.slice(0, 60), e.message); } }
  await db.end();
}, { timeout: 60000 });

test('кешбек: база = сплачено після знижки; майстру одразу 0.5% за повернення і 0.5% за перезапис', async (t) => {
  if (skipIf(t)) return;
  // тести нижче — режим «сума умов» (до 1.5%); режим Босса «один бонус за візит» — окремий тест у кінці
  assert.strictEqual((await admin('PUT', '/api/bonus/master-loyalty', { one_per_visit: false })).status, 200);
  await VL.saveConfig({ one_per_visit: false }); // і кеш налаштувань цього процесу (VL.grant у тестах)
  const r = await admin('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'card', discount_type: 'percent', discount_value: 10 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.final, 900);
  assert.strictEqual(r.body.bonus_base, 900, 'база кешбеку — фактично сплачені 900, не прайс 1000');
  const pct = await topPct();
  const a = (await q(`SELECT pay_bonus_base::float b, COALESCE(pay_bonus_accrued,0)::float acc FROM appointments WHERE id=$1`, [F.appt]))[0];
  assert.strictEqual(a.b, 900);
  assert.strictEqual(r2(a.acc), r2(900 * pct / 100), `кешбек = 900 × ${pct}%`);
  const rw = await rewards(F.appt);
  assert.deepStrictEqual(rw.map(x => [x.condition, x.status, x.percent, x.check_amount, x.amount]),
    [['rebook', 'accrued', 0.5, 900, 4.5], ['return', 'accrued', 0.5, 900, 4.5]]);
  assert.ok(rw.every(x => x.master_client_id === F.masterCard), 'нараховано на картку майстра, знайдену за телефоном');
  const m = (await q(`SELECT client_id FROM masters WHERE id=$1`, [F.master]))[0];
  assert.strictEqual(m.client_id, F.masterCard, 'картку привʼязано до майстра');
  assert.strictEqual(await bal(F.masterCard), 9);
});

test('ідемпотентність: повторний onVisitPaid не нараховує вдруге', async (t) => {
  if (skipIf(t)) return;
  const again = await VL.onVisitPaid(F.appt);
  assert.strictEqual(again.return.granted, false); assert.strictEqual(again.rebook.granted, false);
  assert.strictEqual((await rewards(F.appt)).length, 2);
  assert.strictEqual(await bal(F.masterCard), 9);
});

test('оцінка в мініапі: неоплачений → 409, оплачений 5⭐ → ок, зміна в межах 24 год, після — 409', async (t) => {
  if (skipIf(t)) return;
  assert.strictEqual((await mini('POST', `/appointments/${F.next}/rate`, { stars: 5 })).status, 409, 'неоплачений візит не оцінити');
  assert.strictEqual((await mini('POST', `/appointments/${F.appt}/rate`, { stars: 7 })).status, 400);
  let r = await mini('POST', `/appointments/${F.appt}/rate`, { stars: 4 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await mini('POST', `/appointments/${F.appt}/rate`, { stars: 5 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rating, 5);
  assert.strictEqual((await q(`SELECT count(*)::int n FROM visit_ratings WHERE appointment_id=$1`, [F.appt]))[0].n, 1, 'одна оцінка на візит');
  // до закриття вікна бонус за оцінку не нараховується
  assert.strictEqual((await VL.grant(F.appt, 'rating')).reason, 'condition-not-met');
  await q(`UPDATE visit_ratings SET created_at=NOW()-interval '25 hours', updated_at=NOW()-interval '25 hours' WHERE appointment_id=$1`, [F.appt]);
  r = await mini('POST', `/appointments/${F.appt}/rate`, { stars: 3 });
  assert.strictEqual(r.status, 409, 'після 24 год змінити не можна');
});

test('майстер: третя умова (оцінка ≥5) → разом 1.5% = 13.5', async (t) => {
  if (skipIf(t)) return;
  const g = await VL.grant(F.appt, 'rating');
  assert.strictEqual(g.granted, true, JSON.stringify(g)); assert.strictEqual(g.amount, 4.5);
  const rw = await rewards(F.appt);
  assert.strictEqual(rw.length, 3);
  assert.strictEqual(r2(rw.reduce((s, x) => s + x.amount, 0)), 13.5);
  assert.strictEqual(await bal(F.masterCard), 13.5);
  const h = await admin('GET', `/api/bonus/master-rewards?master_id=${F.master}`);
  assert.strictEqual(h.status, 200); assert.strictEqual(h.body.items.length, 3); assert.strictEqual(h.body.total, 13.5);
  assert.ok(h.body.items.every(x => x.label), 'у кожного нарахування є причина');
});

test('кабінет мініапу: без сум витрат, є «оплачено», бонуси за візит і оцінка', async (t) => {
  if (skipIf(t)) return;
  const r = await mini('GET', '/my');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = JSON.stringify(r.body);
  for (const k of ['"price"', '"spent"', '"total_spent"', '"ltv"', '"paid_amount"']) assert.ok(!s.includes(k), 'кабінет віддає ' + k);
  const h = r.body.history.find(x => x.id === F.appt);
  assert.ok(h, 'візит в історії');
  assert.strictEqual(h.paid, true); assert.strictEqual(h.rating, 5); assert.strictEqual(h.can_rate, false);
  assert.ok(h.bonus_accrued >= 0);
  assert.deepStrictEqual(h.bill, { paid: true, can_pay: false });
  assert.ok(Object.prototype.hasOwnProperty.call(r.body.client, 'points'), 'баланс бонусів лишився');
});

test('низька оцінка (1–3⭐) → тихе сповіщення власнику', async (t) => {
  if (skipIf(t)) return;
  const a2 = await visit(F.client, F.master, { dayShift: -3, paid: true, price: 600 });
  const sent = [];
  const r = await VL.rateVisit({ apptId: a2, clientId: F.client, stars: 2, ownerNotify: async (txt) => { sent.push(txt); } });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.low_alert, true);
  assert.strictEqual(sent.length, 1); assert.match(sent[0], /Низька оцінка/);
  const r5 = await VL.rateVisit({ apptId: a2, clientId: F.client + 999999, stars: 5 });
  assert.strictEqual(r5.error, 'not-found', 'чужий візит не оцінити');
});

test('сторно: скасування оплати знімає всі 3 бонуси майстру і кешбек клієнта', async (t) => {
  if (skipIf(t)) return;
  const r = await admin('POST', `/api/schedule/appointments/${F.appt}/unpay`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const rw = await rewards(F.appt);
  assert.ok(rw.length === 3 && rw.every(x => x.status === 'reversed'), JSON.stringify(rw));
  assert.strictEqual(await bal(F.masterCard), 0);
  const a = (await q(`SELECT pay_bonus_base, COALESCE(pay_bonus_accrued,0)::float acc FROM appointments WHERE id=$1`, [F.appt]))[0];
  assert.strictEqual(a.pay_bonus_base, null); assert.strictEqual(a.acc, 0);
  const h = await admin('GET', `/api/bonus/master-rewards?master_id=${F.master}`);
  assert.ok(h.body.items.every(x => x.status === 'reversed' && x.reverse_reason), 'в історії — сторно з причиною');
});

test('майстер як клієнт: без кешбеку і без бонусу майстру; звільнений — звичайний клієнт', async (t) => {
  if (skipIf(t)) return;
  const other = await master(MARK + ' інший майстер', rnd9());
  const a = await visit(F.masterCard, other, { dayShift: 0, hour: 15, price: 800 });
  const r = await admin('POST', `/api/schedule/appointments/${a}/pay`, { method: 'cash' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.bonus_skipped, 'client-is-master');
  const row = (await q(`SELECT COALESCE(pay_bonus_accrued,0)::float acc FROM appointments WHERE id=$1`, [a]))[0];
  assert.strictEqual(row.acc, 0);
  assert.strictEqual((await rewards(a)).length, 0);
  // звільнили → знову звичайний клієнт
  await q(`UPDATE masters SET active=false WHERE id=$1`, [F.master]);
  assert.strictEqual(await VL.workingMasterOfClient(F.masterCard), null);
  await q(`UPDATE masters SET active=true WHERE id=$1`, [F.master]);
  assert.ok(await VL.workingMasterOfClient(F.masterCard));
});

test('налаштування ставок: валідація і збереження через адмінку', async (t) => {
  if (skipIf(t)) return;
  const cur = (await admin('GET', '/api/bonus/master-loyalty')).body;
  assert.strictEqual(cur.return_pct, 0.5);
  assert.strictEqual((await admin('PUT', '/api/bonus/master-loyalty', { return_pct: 50 })).status, 400);
  const p = await admin('PUT', '/api/bonus/master-loyalty', { rebook_pct: 0.7 });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.rebook_pct, 0.7);
  await admin('PUT', '/api/bonus/master-loyalty', { rebook_pct: cur.rebook_pct });
});

test('один бонус за візит (Босс 04.11): повторна оплата → лише перша умова, решта «one-per-visit»', async (t) => {
  if (skipIf(t)) return;
  const p = await admin('PUT', '/api/bonus/master-loyalty', { one_per_visit: true });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.one_per_visit, true);
  await VL.saveConfig({ one_per_visit: true });
  const r = await admin('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'card', discount_type: 'percent', discount_value: 10 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const acc = (await rewards(F.appt)).filter(x => x.status === 'accrued');
  assert.strictEqual(acc.length, 1, 'рівно один бонус майстру: ' + JSON.stringify(acc));
  assert.strictEqual(acc[0].amount, 4.5);
  assert.strictEqual((await VL.grant(F.appt, 'rating')).reason, 'one-per-visit');
  assert.strictEqual(await bal(F.masterCard), 4.5);
});

test('кешбек за градацією (Босс 04.11): покупки < 30 000 → 1%, ≥ 30 000 → 2%, ≥ 100 000 (Gold) → 3%', async (t) => {
  if (skipIf(t)) return;
  const bonus = require('../lib/bonus');
  const rule = (await q(`INSERT INTO bonus_rules (name,type,trigger_event,percent,category,loyalty_multipliers,priority,is_active,tenant_id)
     VALUES ($1,'percent_check','qa-tier',1,'all',$2,-1000,true,$3) RETURNING id`,
     [MARK + ' градація', JSON.stringify({ spend_tiers: [{ from: 100000, percent: 3 }, { from: 30000, percent: 2 }] }), TENANT]))[0].id;
  try {
    const c = await client(MARK + ' градація', rnd9());
    await q(`UPDATE clients SET total_spent=29999 WHERE id=$1`, [c]);
    const a = await bonus.accrue({ clientId: c, checkAmount: 1000, ruleId: rule, sourceType: 'qa_tier', sourceId: 1 });
    assert.strictEqual(Number(a.amount), 10, '29 999 ₴ покупок → 1%');
    await q(`UPDATE clients SET total_spent=30000 WHERE id=$1`, [c]);
    const b = await bonus.accrue({ clientId: c, checkAmount: 1000, ruleId: rule, sourceType: 'qa_tier', sourceId: 2 });
    assert.strictEqual(Number(b.amount), 20, '30 000 ₴ покупок → 2%');
    await q(`UPDATE clients SET total_spent=100000 WHERE id=$1`, [c]);
    const g = await bonus.accrue({ clientId: c, checkAmount: 1000, ruleId: rule, sourceType: 'qa_tier', sourceId: 3 });
    assert.strictEqual(Number(g.amount), 30, 'Gold: 100 000 ₴ покупок → 3%');
  } finally { await q(`DELETE FROM bonus_rules WHERE id=$1`, [rule]); }
});
