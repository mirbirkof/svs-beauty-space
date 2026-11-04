// 04.11 — рахунок візиту (послуги + товари − знижки) і оплата з телефону через Mono.
// 1) Unit: модель знижок lib/visit-bill (три області, % і грн, 100%, обрізання, сертифікат+бонуси,
//    рівність бази ЗП зі старою формулою для старих візитів).
// 2) QA-інтеграція (Neon-песочниця, НЕ прод): рахунок із товаром, збережені знижки, мініапп — свій
//    рахунок 200 / чужий 403, Mono-вебхук (мок lib/mono, без реальних грошей) проводить оплату в касу
//    «Monobank онлайн», повтор вебхука не дублює касу, зміна рахунку інвалідує інвойс, оплата на касі
//    скасовує інвойс і застосунок бачить «оплачено», оплата скасованого інвойсу → double-paid без повернення.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const VB = require('../lib/visit-bill');

// ───────────────────────────── 1. UNIT ─────────────────────────────
const P = (v) => ({ type: 'percent', value: v });
const G = (v) => ({ type: 'fixed', value: v });

test('модель: без знижок — рахунок = послуги + товари', () => {
  const b = VB.computeBill({ S: 1000, P: 500 });
  assert.strictEqual(b.final, 1500);
  assert.strictEqual(b.discount_total, 0);
  assert.strictEqual(b.service_cash + b.product_cash, 1500);
  assert.strictEqual(b.product_cash, 500);
});

test('модель: три незалежні знижки (% і грн) — послуги, товари, чек поверх', () => {
  const b = VB.computeBill({ S: 1000, P: 500, svc: P(10), prod: G(50), check: P(5) });
  assert.strictEqual(b.discount_services, 100);
  assert.strictEqual(b.discount_products, 50);
  assert.strictEqual(b.services_after, 900);
  assert.strictEqual(b.products_after, 450);
  assert.strictEqual(b.discount_check, 67.5); // 5% від 1350
  assert.strictEqual(b.final, 1282.5);
  assert.strictEqual(VB.round2(b.service_cash + b.product_cash), 1282.5);
  // товари отримують частку чека пропорційно 450/1350
  assert.strictEqual(b.product_cash, 427.5);
  // база ЗП майстра: 900 − 67.5 × 900/1350 = 855
  assert.strictEqual(b.real_amount, 855);
});

test('модель: 100% на послуги і знижка більша за частину — без мінуса', () => {
  const a = VB.computeBill({ S: 800, P: 300, svc: P(100) });
  assert.strictEqual(a.discount_services, 800);
  assert.strictEqual(a.final, 300);
  assert.strictEqual(a.real_amount, 0);
  const b = VB.computeBill({ S: 800, P: 300, prod: G(1000), check: G(5000) });
  assert.strictEqual(b.discount_products, 300); // обрізано до суми товарів
  assert.strictEqual(b.discount_check, 800);    // обрізано до решти чека
  assert.strictEqual(b.final, 0);
  assert.ok(b.service_cash >= 0 && b.product_cash >= 0);
  assert.strictEqual(VB.normSpec(P(250)).value, 100); // % > 100 → 100
  assert.strictEqual(VB.normSpec(G(-5)), null);       // від'ємна знижка ігнорується
});

test('модель: лише товари / лише послуги, знижка не на свою частину = 0', () => {
  const onlyP = VB.computeBill({ S: 0, P: 400, svc: P(50), prod: P(25) });
  assert.strictEqual(onlyP.discount_services, 0);
  assert.strictEqual(onlyP.final, 300);
  assert.strictEqual(onlyP.product_cash, 300);
  const onlyS = VB.computeBill({ S: 600, P: 0, prod: G(100), svc: G(100) });
  assert.strictEqual(onlyS.discount_products, 0);
  assert.strictEqual(onlyS.final, 500);
  assert.strictEqual(onlyS.product_cash, 0);
});

test('модель: сертифікат і бонуси — після знижок, обрізаються до решти', () => {
  const b = VB.computeBill({ S: 1000, P: 200, svc: P(20), check: G(100), cert: 300, bonus: 150 });
  // 800 + 200 = 1000 − 100 = 900 − cert 300 = 600 − bonus 150 = 450
  assert.strictEqual(b.final, 450);
  assert.strictEqual(b.certificate, 300);
  assert.strictEqual(b.bonus, 150);
  const c = VB.computeBill({ S: 300, P: 0, cert: 1000, bonus: 50 });
  assert.strictEqual(c.certificate, 300);
  assert.strictEqual(c.bonus, 0);
  assert.strictEqual(c.final, 0);
});

test('модель: передоплата віднімається останньою', () => {
  const b = VB.computeBill({ S: 1000, P: 0, check: P(10), prepaid: 200 });
  assert.strictEqual(b.final, 700);
  assert.strictEqual(b.prepaid, 200);
});

test('модель: старі візити — база ЗП побітово = стара формула price − total×price/base', () => {
  const cases = [[1000, 0, 100], [1350, 270, 333.33], [999.99, 123.45, 77.77], [500, 500, 1000], [1234, 56, 0.01]];
  for (const [S, Pp, total] of cases) {
    const old = Math.round((S - total * (S / (S + Pp))) * 100) / 100;
    assert.strictEqual(VB.realServiceAmount({ S, P: Pp, other: total }), Math.max(0, old), `S=${S} P=${Pp} total=${total}`);
  }
});

test('модель: resolveSpecs — нова каса / стара одна знижка = «на чек» / збережені на візиті', () => {
  assert.deepStrictEqual(VB.resolveSpecs({ discounts: { services: P(10), products: null, check: G(20) } }, {}),
    { svc: P(10), prod: null, check: G(20) });
  assert.deepStrictEqual(VB.resolveSpecs({ discount_type: 'percent', discount_value: 15 }, {}),
    { svc: null, prod: null, check: P(15) });
  assert.deepStrictEqual(VB.resolveSpecs({}, { disc_prod_type: 'fixed', disc_prod_value: '40' }),
    { svc: null, prod: G(40), check: null });
});

// ─────────────────────── 2. QA-ІНТЕГРАЦІЯ ───────────────────────
const QA_URL = process.env.QA_DB_URL;
const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.VISIT_BILL_TEST_PORT || 3063);
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = 'QA-VBILL-0411';
const BOT = '123456:QA-fake-bot-token-visit-bill';
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const skipIf = (t) => { if (!QA_URL) { t.skip('нет QA_DB_URL'); return true; } return false; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let db, S, PM, mono, tenantLib;
const F = { appts: [] };
const invoices = new Map(); // мок Mono: invoiceId → { amount }
const removed = [];

const q = async (sql, p) => (await db.query(sql, p)).rows;
const api = async (method, url, body, headers = {}) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token, ...headers },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const initFor = (tgId) => require('../lib/tg-initdata').sign({ auth_date: Math.floor(Date.now() / 1000), user: { id: tgId, first_name: 'QA' } }, BOT);
const mini = (method, url, tgId) => api(method, '/api/miniapp' + url, null, { 'X-Telegram-Init-Data': initFor(tgId) });
const inProc = (fn) => tenantLib.runAs(TENANT, fn);
const cash = async (id) => (await q(
  `SELECT category, method, amount::float AS amount FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in' ORDER BY category`, [id]));
const sum = (rows) => VB.round2(rows.reduce((s, r) => s + r.amount, 0));

async function newAppt(price, hour, withProduct = true) {
  const id = (await q(
    `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
     VALUES ($1,$2,$3, (($4::date + ($7 || ':00')::time) AT TIME ZONE 'Europe/Kyiv'),
             (($4::date + ($7 || ':00')::time + interval '1 hour') AT TIME ZONE 'Europe/Kyiv'), 'confirmed', $5, $6, 'qa-test', $8)
     RETURNING id`, [F.client, F.master, F.service, kyivToday(), price, TENANT, String(hour).padStart(2, '0'), MARK]))[0].id;
  F.appts.push(id);
  if (withProduct) {
    await q(`INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, note, billable, tenant_id)
             VALUES ($1,$2,2,$3,true,$4)`, [id, F.variant, MARK, TENANT]);
  }
  return id;
}

before(async () => {
  if (!QA_URL) return;
  const { Client } = require('pg');
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  F.tg = 900000000 + Math.floor(Math.random() * 90000000);
  F.tgOther = F.tg + 1;
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source, telegram_id) VALUES ($1,$2,'qa-test',$3) RETURNING id`, [MARK, TENANT, F.tg]))[0].id;
  F.other = (await q(`INSERT INTO clients (name, tenant_id, source, telegram_id) VALUES ($1,$2,'qa-test',$3) RETURNING id`, [MARK + '-other', TENANT, F.tgOther]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.product = 'qa-vbill-' + Date.now().toString(36);
  await q(`INSERT INTO products (id, name, tenant_id) VALUES ($1,$2,$3)`, [F.product, MARK + ' крем', TENANT]);
  F.variant = (await q(`INSERT INTO product_variants (product_id, price, tenant_id) VALUES ($1,250,$2) RETURNING id`, [F.product, TENANT]))[0].id;

  // сервер CRM на песочниці; фейковий токен бота — лише щоб мініапп перевіряв підписаний initData
  S = await require('./_qa-server').startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT } });

  // Mono-частина в процесі тесту поверх тієї ж песочниці; lib/mono замоканий — жодних реальних грошей
  process.env.DATABASE_URL = QA_URL; process.env.DATABASE_URL_APP = QA_URL;
  process.env.TELEGRAM_BOT_TOKEN = ''; process.env.TELEGRAM_NOTIFY_TOKEN = ''; process.env.ADMIN_TG_CHAT = '';
  process.env.MONO_TOKEN = ''; process.env.QA_STAGING = '1';
  mono = require('../lib/mono');
  mono.createInvoice = async ({ amountUah }) => {
    const invoiceId = 'qa-inv-' + Math.random().toString(36).slice(2, 12);
    invoices.set(invoiceId, { amount: amountUah });
    return { invoiceId, pageUrl: 'https://pay.example.invalid/' + invoiceId };
  };
  mono.removeInvoice = async (id) => { removed.push(id); return {}; };
  mono.getInvoiceStatus = async (id) => ({ invoiceId: id, status: 'created' });
  tenantLib = require('../lib/tenant');
  PM = require('../routes/payments-mono');
}, { timeout: 180000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  const ids = F.appts;
  const steps = [
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM payments WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM bonus_transactions WHERE client_id = ANY($1::int[])`, [[F.client, F.other]]],
    [`DELETE FROM bonus_balances WHERE client_id = ANY($1::int[])`, [[F.client, F.other]]],
    [`DELETE FROM stock_movements WHERE variant_id=$1`, [F.variant]],
    [`DELETE FROM appointment_materials WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]],
    [`DELETE FROM product_variants WHERE id=$1`, [F.variant]],
    [`DELETE FROM products WHERE id=$1`, [F.product]],
    [`DELETE FROM services WHERE id=$1`, [F.service]],
    [`DELETE FROM masters WHERE id=$1`, [F.master]],
    [`DELETE FROM clients WHERE id = ANY($1::int[])`, [[F.client, F.other]]],
  ];
  for (const [sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', sql.slice(0, 50), e.message); } }
  await db.end();
  try { await require('../db-pg').getPool().end(); } catch (_) {}
}, { timeout: 60000 });

test('рахунок: послуги 1000 + товар 2×250 → 1500; збережені знижки → 1282.50 з рядками', async (t) => {
  if (skipIf(t)) return;
  F.a1 = await newAppt(1000, 10);
  const g = await api('GET', `/api/schedule/appointments/${F.a1}/bill`);
  assert.strictEqual(g.status, 200, JSON.stringify(g.body));
  assert.strictEqual(g.body.services_total, 1000);
  assert.strictEqual(g.body.products_total, 500);
  assert.strictEqual(g.body.final, 1500);
  const p = await api('PUT', `/api/schedule/appointments/${F.a1}/bill`,
    { discounts: { services: P(10), products: G(50), check: P(5) } });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.strictEqual(p.body.final, 1282.5);
  const labels = p.body.lines.map((l) => l.label).join(' | ');
  assert.match(labels, /Знижка на послуги/);
  assert.match(labels, /Знижка на товари/);
  assert.match(labels, /Знижка на чек/);
});

test('мініапп: власник бачить ту саму суму 1282.50; чужий клієнт і неіснуючий запис → 403', async (t) => {
  if (skipIf(t)) return;
  const own = await mini('GET', `/appointments/${F.a1}/bill`, F.tg);
  assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  assert.strictEqual(own.body.bill.amount, 1282.5);
  assert.strictEqual(own.body.bill.can_pay, true);
  const foreign = await mini('GET', `/appointments/${F.a1}/bill`, F.tgOther);
  assert.strictEqual(foreign.status, 403);
  const foreignPay = await mini('POST', `/appointments/${F.a1}/pay`, F.tgOther);
  assert.strictEqual(foreignPay.status, 403);
  const ghost = await mini('GET', `/appointments/2147483000/bill`, F.tg);
  assert.strictEqual(ghost.status, 403);
  const noSig = await api('GET', `/api/miniapp/appointments/${F.a1}/bill`, null, { 'X-Telegram-Init-Data': 'user=%7B%22id%22%3A1%7D&hash=bad' });
  assert.strictEqual(noSig.status, 401);
});

test('Mono: інвойс на суму рахунку, повторний запит переюзає; вебхук success → каса «mono», візит оплачено', async (t) => {
  if (skipIf(t)) return;
  const inv = await inProc(() => PM.createInvoiceForAppointment(F.a1));
  assert.strictEqual(inv.amount, 1282.5);
  assert.strictEqual(invoices.get(inv.invoiceId).amount, 1282.5);
  const again = await inProc(() => PM.createInvoiceForAppointment(F.a1));
  assert.strictEqual(again.invoiceId, inv.invoiceId);
  assert.strictEqual(again.reused, true);

  await PM.applyInvoiceStatus({ invoiceId: inv.invoiceId, status: 'success', amount: 128250, finalAmount: 128250 });
  const ops = await cash(F.a1);
  assert.strictEqual(sum(ops), 1282.5, JSON.stringify(ops));
  assert.ok(ops.every((o) => o.method === 'mono'), JSON.stringify(ops));
  const prod = ops.filter((o) => /product/.test(o.category));
  assert.strictEqual(sum(prod), 427.5, 'частка товарів після знижок: ' + JSON.stringify(ops));
  const a = (await q(`SELECT status, discount_services_amount::float AS ds, discount_products_amount::float AS dp,
                             discount_check_amount::float AS dc, bill_products_total::float AS bp, real_amount::float AS ra
                        FROM appointments WHERE id=$1`, [F.a1]))[0];
  assert.deepStrictEqual([a.ds, a.dp, a.dc, a.bp, a.ra], [100, 50, 67.5, 500, 855]);
  const pay = (await q(`SELECT status FROM payments WHERE invoice_id=$1`, [inv.invoiceId]))[0];
  assert.strictEqual(pay.status, 'success');
  const view = await mini('GET', `/appointments/${F.a1}/bill`, F.tg);
  assert.strictEqual(view.body.bill.paid, true);
  assert.strictEqual(view.body.bill.can_pay, false);
  assert.strictEqual(view.body.bill.amount, undefined, "оплачений рахунок — без сум (рішення Боса)");
});

test('Mono: повторний вебхук і крон-поллінг не дублюють касу (ідемпотентно)', async (t) => {
  if (skipIf(t)) return;
  const inv = (await q(`SELECT invoice_id FROM payments WHERE appointment_id=$1 AND purpose='appt_bill' AND status='success'`, [F.a1]))[0].invoice_id;
  await PM.applyInvoiceStatus({ invoiceId: inv, status: 'success', amount: 128250 });
  await PM.applyInvoiceStatus({ invoiceId: inv, status: 'success', amount: 128250 });
  const ops = await cash(F.a1);
  assert.strictEqual(sum(ops), 1282.5, JSON.stringify(ops));
  const r = await inProc(() => PM.createInvoiceForAppointment(F.a1));
  assert.strictEqual(r.alreadyPaid, true);
});

test('зміна рахунку після інвойсу → старий інвалідується; оплата старої суми не проводиться в касу', async (t) => {
  if (skipIf(t)) return;
  F.a2 = await newAppt(600, 11);
  const inv1 = await inProc(() => PM.createInvoiceForAppointment(F.a2));
  assert.strictEqual(inv1.amount, 1100);
  const p = await api('PUT', `/api/schedule/appointments/${F.a2}/bill`, { discounts: { check: G(100) } });
  assert.strictEqual(p.body.final, 1000);
  const st = (await q(`SELECT status, failure_reason FROM payments WHERE invoice_id=$1`, [inv1.invoiceId]))[0];
  assert.strictEqual(st.status, 'superseded');
  const inv2 = await inProc(() => PM.createInvoiceForAppointment(F.a2));
  assert.notStrictEqual(inv2.invoiceId, inv1.invoiceId);
  assert.strictEqual(inv2.amount, 1000);
  // клієнт устиг сплатити старий інвойс на 1100 — сума не збігається з рахунком → каса не чіпається, алерт
  await PM.applyInvoiceStatus({ invoiceId: inv1.invoiceId, status: 'success', amount: 110000 });
  assert.strictEqual(sum(await cash(F.a2)), 0);
  const r1 = (await q(`SELECT failure_reason FROM payments WHERE invoice_id=$1`, [inv1.invoiceId]))[0];
  assert.match(String(r1.failure_reason), /cash-failed|bill-changed/);
  // актуальний інвойс на 1000 — проводиться
  await PM.applyInvoiceStatus({ invoiceId: inv2.invoiceId, status: 'success', amount: 100000 });
  assert.strictEqual(sum(await cash(F.a2)), 1000);
});

test('оплата на касі (термінал) → відкритий інвойс скасовано, застосунок «оплачено»; оплата скасованого → double-paid без повернення', async (t) => {
  if (skipIf(t)) return;
  F.a3 = await newAppt(800, 12, false);
  const inv = await inProc(() => PM.createInvoiceForAppointment(F.a3));
  assert.strictEqual(inv.amount, 800);
  const pay = await api('POST', `/api/schedule/appointments/${F.a3}/pay`, { method: 'card', discounts: { services: P(25) } });
  assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
  assert.strictEqual(sum(await cash(F.a3)), 600);
  let st;
  for (let i = 0; i < 20; i++) { st = (await q(`SELECT status, failure_reason FROM payments WHERE invoice_id=$1`, [inv.invoiceId]))[0]; if (st.status !== 'created') break; await wait(300); }
  assert.strictEqual(st.status, 'cancelled');
  assert.strictEqual(st.failure_reason, 'paid-at-desk');
  const view = await mini('GET', `/appointments/${F.a3}/bill`, F.tg);
  assert.strictEqual(view.body.bill.paid, true);
  assert.strictEqual(view.body.bill.can_pay, false);
  assert.strictEqual(view.body.bill.amount, undefined, "оплачений рахунок — без сум (рішення Боса)");
  const payBtn = await mini('POST', `/appointments/${F.a3}/pay`, F.tg);
  assert.strictEqual(payBtn.body.already_paid, true);
  // клієнт таки сплатив старе посилання → касу не чіпаємо, позначка double-paid (алерт власнику)
  await PM.applyInvoiceStatus({ invoiceId: inv.invoiceId, status: 'success', amount: 80000 });
  assert.strictEqual(sum(await cash(F.a3)), 600);
  const d = (await q(`SELECT failure_reason FROM payments WHERE invoice_id=$1`, [inv.invoiceId]))[0];
  assert.strictEqual(d.failure_reason, 'double-paid');
});

test('товари змінили після оплати (каса) → рахунок і каса пересинхронізовані, знижки збережено', async (t) => {
  if (skipIf(t)) return;
  F.a4 = await newAppt(1000, 13);
  const pay = await api('POST', `/api/schedule/appointments/${F.a4}/pay`, { method: 'cash', discounts: { products: P(20), check: G(100) } });
  assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
  // 1000 + (500−100) = 1400 − 100 = 1300
  assert.strictEqual(sum(await cash(F.a4)), 1300);
  const b = await api('GET', `/api/schedule/appointments/${F.a4}/bill`);
  assert.strictEqual(b.body.paid, true);
  assert.strictEqual(b.body.paid_amount, 1300);
  // адмін змінив кількість товару після оплати: 4×250 = 1000 − 20% = 800; 1000 + 800 − 100 = 1700
  const m = await api('POST', `/api/consumables/appointment/${F.a4}`, { variant_id: F.variant, qty_used: 4, billable: true });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  const ops = await cash(F.a4);
  assert.strictEqual(sum(ops), 1700, JSON.stringify(ops));
  const a = (await q(`SELECT discount_products_amount::float AS dp, discount_check_amount::float AS dc, bill_products_total::float AS bp
                        FROM appointments WHERE id=$1`, [F.a4]))[0];
  assert.deepStrictEqual([a.dp, a.dc, a.bp], [200, 100, 1000]);
  const again = await api('PUT', `/api/schedule/appointments/${F.a4}/bill`, { discounts: { check: P(50) } });
  assert.strictEqual(again.status, 409); // оплачений рахунок через PUT не змінюється
});
