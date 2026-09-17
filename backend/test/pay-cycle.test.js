// ВОРОТА ДЕПЛОЯ — ДЕНЬГИ (17.09, Босс: «тесты кассы и графика как ворота деплоя»).
//
// ЧТО ЛОВИМ. Обработчик оплаты визита (routes/schedule.js POST /appointments/:id/pay,
// ~400 строк) — самый правленый код проекта и единственный, через который деньги
// попадают в кассу. До этого файла он не имел ни одного теста: любая правка
// проверялась руками. Здесь — живой сервер + живая QA-база + полный цикл:
//   оплата → идемпотентность → журнал дня → возврат → скидка+сертификат+бонусы →
//   возврат с восстановлением → смешанная оплата (ошибка суммы и норма) →
//   гонка двух касс → бесплатный визит → чужой сертификат.
//
// БЕЗОПАСНОСТЬ. Сервер поднимается ОТДЕЛЬНЫМ процессом на :3037 поверх QA_DB_URL
// (Neon-песочница, НЕ прод Supabase), с QA_STAGING=1 (все рассылки/кроны заглушены),
// без телеграм/моно-токенов и со своим одноразовым admin-токеном. Все фикстуры
// помечены QA-PAY-TEST и удаляются в after(). Нет QA_DB_URL → файл пропускается,
// щит не краснеет (но и денег не защищает — это видно в выводе).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.PAY_TEST_PORT || 3037);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-PAY-TEST';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

let db, S;
const F = { ids: { appts: [] } }; // фикстуры

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, body: json };
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const appt = async (id) => (await q(
  `SELECT status, price, pay_settled_at, real_amount, discount_amount, pay_cert_code, pay_cert_amount,
          pay_bonus_redeemed, pay_bonus_money, pay_bonus_accrued FROM appointments WHERE id=$1`, [id]))[0];
const cashOps = (id) => q(
  `SELECT id, category, amount::float AS amount, method FROM cash_operations
    WHERE ref_type='appointment' AND ref_id=$1 AND type='in' ORDER BY id`, [id]);
const balance = async () => Number((await q(`SELECT COALESCE(balance,0)::float b FROM bonus_balances WHERE client_id=$1`, [F.client]))[0]?.b || 0);
const cert = async () => (await q(`SELECT remaining_amount::float AS remaining, status FROM gift_certificates WHERE id=$1`, [F.cert]))[0];
const findById = (node, id) => { // ищем объект визита в любом месте JSON журнала
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const x of node) { const f = findById(x, id); if (f) return f; } return null; }
  if (Number(node.id) === id && ('starts_at' in node || 'paid' in node)) return node;
  for (const k of Object.keys(node)) { const f = findById(node[k], id); if (f) return f; }
  return null;
};

async function newAppointment(price, hour = 12) {
  const row = (await q(
    `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
     VALUES ($1,$2,$3, (($4::date + ($8 || ':00')::time) AT TIME ZONE 'Europe/Kyiv'),
             (($4::date + ($8 || ':00')::time + interval '1 hour') AT TIME ZONE 'Europe/Kyiv'), 'confirmed', $5, $6, 'qa-test', $7)
     RETURNING id`, [F.client, F.master, F.service, kyivToday(), price, TENANT, MARK, String(hour).padStart(2,'0')]))[0];
  F.ids.appts.push(row.id);
  return row.id;
}

before(async () => {
  if (!QA_URL) return; // пропуск ниже, в каждом тесте
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── фикстуры ──
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source) VALUES ($1,$2,'qa-test') RETURNING id`, [MARK, TENANT]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, TENANT]))[0].id;
  F.certCode = 'QAPAY' + Date.now().toString(36).toUpperCase();
  F.cert = (await q(
    `INSERT INTO gift_certificates (code, type, original_amount, remaining_amount, status, valid_until, tenant_id, notes)
     VALUES ($1,'amount',300,300,'active', (CURRENT_DATE + 365), $2, $3) RETURNING id`, [F.certCode, TENANT, MARK]))[0].id;
  // правило начисления 3% с максимальным приоритетом — чтобы тест не зависел от чужих правил QA
  F.rule = (await q(
    `INSERT INTO bonus_rules (tenant_id, name, type, trigger_event, percent, category, is_active, priority, min_check_amount)
     VALUES ($1,$2,'percent_check','payment',3,'all',true,100000,0) RETURNING id`, [TENANT, MARK]))[0].id;
  // стартовый баланс бонусов 200 (отлежавшийся лот — доступен к списанию сразу)
  await q(`INSERT INTO bonus_balances (tenant_id, client_id, balance, total_accrued) VALUES ($1,$2,200,200)
           ON CONFLICT (client_id) DO UPDATE SET balance=200, total_accrued=200`, [TENANT, F.client]).catch(async () => {
    await q(`DELETE FROM bonus_balances WHERE client_id=$1`, [F.client]);
    await q(`INSERT INTO bonus_balances (tenant_id, client_id, balance, total_accrued) VALUES ($1,$2,200,200)`, [TENANT, F.client]);
  });
  await q(`INSERT INTO bonus_transactions (tenant_id, client_id, type, amount, balance_after, remaining, source_type, description, available_at)
           VALUES ($1,$2,'accrual',200,200,200,'qa-test',$3, now())`, [TENANT, F.client, MARK]);
  F.appt = await newAppointment(1000);

  // абонемент: план на 2 визита, покрывающий нашу услугу
  F.plan = (await q(
    `INSERT INTO subscription_plans (name, type, visits_included, duration_days, price, service_ids, active, tenant_id)
     VALUES ($1,'visits',2,90,2000,ARRAY[$2]::int[],true,$3) RETURNING id`, [MARK, F.service, TENANT]))[0].id;
  F.sub = (await q(
    `INSERT INTO subscriptions (plan_id, client_id, subscription_number, status, visits_remaining, started_at, expires_at, tenant_id, notes)
     VALUES ($1,$2,$3,'active',2, CURRENT_DATE, CURRENT_DATE + 90, $4, $5) RETURNING id`,
    [F.plan, F.client, 'QA-SUB-' + Date.now(), TENANT, MARK]))[0].id;

  // ── сервер на песочнице (общий помощник _qa-server.js) ──
  S = await startQaServer({ port: PORT });
  F.balance0 = await balance();
}, { timeout: 150000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  const ids = F.ids.appts;
  const steps = [
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM gift_certificate_transactions WHERE gc_id=$1`, [F.cert]],
    [`DELETE FROM bonus_transactions WHERE client_id=$1`, [F.client]],
    [`DELETE FROM bonus_balances WHERE client_id=$1`, [F.client]],
    [`DELETE FROM subscription_usage WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM online_bookings WHERE note = $1`, [MARK]],
    [`DELETE FROM subscriptions WHERE id=$1`, [F.sub]],
    [`DELETE FROM subscription_plans WHERE id=$1`, [F.plan]],
    [`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]],
    [`DELETE FROM gift_certificates WHERE id=$1`, [F.cert]],
    [`DELETE FROM bonus_rules WHERE id=$1`, [F.rule]],
    [`DELETE FROM services WHERE id=$1`, [F.service]],
    [`DELETE FROM masters WHERE id=$1`, [F.master]],
    [`DELETE FROM clients WHERE id=$1`, [F.client]],
    [`DELETE FROM tasks WHERE title ILIKE '%' || $1 || '%'`, [MARK]],
  ];
  for (const [sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', sql.slice(0, 50), e.message); } }
  await db.end();
}, { timeout: 60000 });

const skipIf = (t) => { if (!QA_URL) { t.skip('нет QA_DB_URL — тесты кассы на живом сервере пропущены'); return true; } return false; };

test('касса: оплата наличными без скидок — 1000 в кассу, визит выполнен, бонусы начислены', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'cash' });
  assert.strictEqual(r.status, 200, 'ответ 200: ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.base, 1000); assert.strictEqual(r.body.final, 1000);
  const ops = await cashOps(F.appt);
  assert.strictEqual(ops.length, 1, 'ровно одна касовая операция');
  assert.deepStrictEqual([ops[0].category, ops[0].amount, ops[0].method], ['sale_service', 1000, 'cash']);
  const a = await appt(F.appt);
  assert.strictEqual(a.status, 'done'); assert.ok(a.pay_settled_at, 'pay_settled_at выставлен');
  assert.strictEqual(Number(a.real_amount), 1000, 'база ЗП мастера = цена без скидок');
  // начисление: правило 3% → 30 (или больше при множителе уровня лояльности), и след в истории совпадает
  const acc = (await q(`SELECT amount::float a FROM bonus_transactions WHERE client_id=$1 AND type='accrual' AND source_type='appointment' AND source_id=$2`, [F.client, F.appt]))[0];
  assert.ok(acc && acc.a >= 30, 'начислено не меньше 3% чека: ' + JSON.stringify(acc));
  assert.strictEqual(r2(r.body.bonus_accrued), r2(acc.a), 'ответ и история бонусов совпадают');
  assert.strictEqual(r2(Number(a.pay_bonus_accrued)), r2(acc.a));
  F.accrued1 = r2(acc.a);
  assert.strictEqual(r2(await balance()), r2(F.balance0 + F.accrued1), 'баланс вырос ровно на начисление');
});

test('касса: повторная оплата того же визита — идемпотентна, второй операции нет', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'card' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.already_paid, true);
  assert.strictEqual((await cashOps(F.appt)).length, 1, 'кассовая операция по-прежнему одна');
});

test('журнал дня: оплаченный визит виден как оплаченный с суммой', async (t) => {
  if (skipIf(t)) return;
  const r = await api('GET', `/api/schedule/journal?date=${kyivToday()}`);
  assert.strictEqual(r.status, 200, 'журнал 200: ' + JSON.stringify(r.body).slice(0, 200));
  const row = findById(r.body, F.appt);
  assert.ok(row, 'визит присутствует в журнале дня');
  assert.strictEqual(row.status, 'done');
  assert.ok(row.paid === true || row.paid === 't', 'помечен оплаченным');
  assert.strictEqual(r2(row.paid_total), 1000, 'сумма оплаты в журнале = 1000');
});

test('касса: возврат оплаты — касса чистая, визит снова подтверждён, начисленные бонусы сняты', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/unpay`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.ok, true);
  assert.strictEqual((await cashOps(F.appt)).length, 0, 'приход из кассы убран (открытый период)');
  const a = await appt(F.appt);
  assert.strictEqual(a.status, 'confirmed'); assert.strictEqual(a.pay_settled_at, null);
  assert.strictEqual(a.real_amount, null); assert.strictEqual(a.pay_bonus_accrued, null);
  assert.strictEqual(r2(await balance()), r2(F.balance0), 'баланс бонусов вернулся к исходному');
});

test('касса: скидка 10% + сертификат 300 + бонусы 50 — в кассу ровно остаток, всё списано верно', async (t) => {
  if (skipIf(t)) return;
  const b0 = await balance();
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`,
    { method: 'card', discount_type: 'percent', discount_value: 10, certificate_code: F.certCode, bonus_amount: 50 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.ok, true);
  // 1000 − 10% (100) = 900 → сертификат 300 → 600 → бонусы 50 (лимит 30% от 600 = 180, проходит) → 550
  assert.deepStrictEqual(r.body.discount, { manual: 100, certificate: 300, bonus: 50, total: 450 });
  assert.strictEqual(r.body.final, 550);
  const ops = await cashOps(F.appt);
  assert.strictEqual(ops.length, 1); assert.strictEqual(ops[0].amount, 550); assert.strictEqual(ops[0].method, 'card');
  const a = await appt(F.appt);
  assert.strictEqual(Number(a.discount_amount), 100); assert.strictEqual(a.pay_cert_code, F.certCode);
  assert.strictEqual(Number(a.pay_cert_amount), 300); assert.strictEqual(Number(a.pay_bonus_redeemed), 50);
  assert.strictEqual(Number(a.real_amount), 550, 'база ЗП = цена минус все скидки (материалов нет)');
  const c = await cert();
  assert.strictEqual(c.remaining, 0); assert.strictEqual(c.status, 'fully_used');
  const usage = await q(`SELECT amount::float a FROM gift_certificate_transactions WHERE gc_id=$1 AND type='usage' AND appointment_id=$2`, [F.cert, F.appt]);
  assert.strictEqual(usage.length, 1); assert.strictEqual(usage[0].a, 300);
  F.accrued2 = r2(r.body.bonus_accrued);
  assert.ok(F.accrued2 >= r2(550 * 0.03), 'бонусы начислены от реально оплаченных 550, не от 1000');
  assert.strictEqual(r2(await balance()), r2(b0 - 50 + F.accrued2), 'баланс: −50 списано, +начисление');
});

test('касса: возврат оплаты со скидками — сертификат и бонусы вернулись целиком', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/unpay`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(Number(r.body.reverted_cert), 300); assert.strictEqual(Number(r.body.reverted_bonus), 50);
  const c = await cert();
  assert.strictEqual(c.remaining, 300); assert.strictEqual(c.status, 'active');
  assert.strictEqual((await cashOps(F.appt)).length, 0);
  const a = await appt(F.appt);
  assert.strictEqual(a.status, 'confirmed'); assert.strictEqual(a.pay_cert_code, null); assert.strictEqual(a.discount_amount, null);
  assert.strictEqual(r2(await balance()), r2(F.balance0), 'баланс бонусов снова исходный');
});

test('касса: смешанная оплата с неверной суммой — отказ 400 и визит НЕ остаётся «оплаченным» (регресс v8)', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'mixed', mixed_cash: 100, mixed_card: 100 });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'mixed-sum-mismatch');
  assert.strictEqual(r.body.expected, 1000);
  const a = await appt(F.appt);
  assert.strictEqual(a.pay_settled_at, null, 'захват оплаты снят после отказа'); assert.strictEqual(a.status, 'confirmed');
  assert.strictEqual((await cashOps(F.appt)).length, 0);
});

test('касса: смешанная оплата 400 нал + 600 карта — две операции, сумма 1000; возврат убирает обе', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'mixed', mixed_cash: 400, mixed_card: 600 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.final, 1000);
  const ops = await cashOps(F.appt);
  assert.deepStrictEqual(ops.map((o) => [o.method, o.amount]).sort(), [['card', 600], ['cash', 400]]);
  const u = await api('POST', `/api/schedule/appointments/${F.appt}/unpay`);
  assert.strictEqual(u.status, 200); assert.strictEqual(u.body.cancelled.length, 2);
  assert.strictEqual((await cashOps(F.appt)).length, 0);
  assert.strictEqual(r2(await balance()), r2(F.balance0));
});

test('касса: две кассы жмут «оплатить» одновременно — деньги в кассу попадают ОДИН раз', async (t) => {
  if (skipIf(t)) return;
  const [a1, a2] = await Promise.all([
    api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'cash' }),
    api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'cash' }),
  ]);
  assert.strictEqual(a1.status, 200, JSON.stringify(a1.body)); assert.strictEqual(a2.status, 200, JSON.stringify(a2.body));
  const ops = await cashOps(F.appt);
  assert.strictEqual(ops.length, 1, 'ровно одна операция, несмотря на гонку'); assert.strictEqual(ops[0].amount, 1000);
  assert.strictEqual([a1.body, a2.body].filter((b) => b.already_paid).length, 1, 'один из ответов — «уже оплачено»');
  const u = await api('POST', `/api/schedule/appointments/${F.appt}/unpay`);
  assert.strictEqual(u.status, 200);
  assert.strictEqual(r2(await balance()), r2(F.balance0), 'после гонки и возврата бонусы не потерялись');
});

test('касса: несуществующий сертификат — отказ и визит остаётся неоплаченным', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.appt}/pay`, { method: 'cash', certificate_code: 'NOPE-' + Date.now() });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'cert-not-found');
  const a = await appt(F.appt);
  assert.strictEqual(a.pay_settled_at, null); assert.strictEqual((await cashOps(F.appt)).length, 0);
});

test('касса: бесплатный визит (0 грн) закрывается без кассы', async (t) => {
  if (skipIf(t)) return;
  const id = await newAppointment(0, 15); // другой час: у мастера защита от пересечения записей
  const r = await api('POST', `/api/schedule/appointments/${id}/pay`, { method: 'cash' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.comped, true);
  assert.strictEqual((await appt(id)).status, 'done'); assert.strictEqual((await cashOps(id)).length, 0);
});

// ─────────────── АБОНЕМЕНТ (18.08: «кассир забудет» — экран сам предлагает) ───────────────
test('касса: экран оплаты сам предлагает подходящий абонемент клиента', async (t) => {
  if (skipIf(t)) return;
  const id = await newAppointment(1000, 16);
  const r = await api('GET', `/api/schedule/appointments/${id}/pay-options`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const found = JSON.stringify(r.body).includes(String(F.sub));
  assert.ok(found, 'абонемент предложен на экране оплаты: ' + JSON.stringify(r.body).slice(0, 300));
  F.apptSub = id;
});

test('касса: оплата абонементом — услуга покрыта, визит списан, кассы нет', async (t) => {
  if (skipIf(t)) return;
  const id = F.apptSub;
  const r = await api('POST', `/api/schedule/appointments/${id}/pay`, { method: 'cash', subscription_id: F.sub });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.final, 0, 'услуга полностью покрыта абонементом, доплаты нет');
  assert.strictEqual(r.body.subscription_used?.id, F.sub);
  assert.strictEqual(r.body.subscription_used?.applied, 1000);
  assert.strictEqual((await cashOps(id)).length, 0, 'денег в кассу не поступало');
  const sub = (await q(`SELECT visits_remaining FROM subscriptions WHERE id=$1`, [F.sub]))[0];
  assert.strictEqual(Number(sub.visits_remaining), 1, 'списан ровно один визит из двух');
  const use = await q(`SELECT id FROM subscription_usage WHERE subscription_id=$1 AND appointment_id=$2`, [F.sub, id]);
  assert.strictEqual(use.length, 1, 'списание записано в историю абонемента');
});

test('касса: повторная оплата абонементом НЕ списывает второй визит', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.apptSub}/pay`, { method: 'cash', subscription_id: F.sub });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number((await q(`SELECT visits_remaining FROM subscriptions WHERE id=$1`, [F.sub]))[0].visits_remaining), 1);
});

test('касса: отмена оплаты возвращает визит абонемента (18.08 — иначе он сгорал)', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.apptSub}/unpay`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(Number((await q(`SELECT visits_remaining FROM subscriptions WHERE id=$1`, [F.sub]))[0].visits_remaining), 2,
    'визит вернулся на абонемент');
  assert.strictEqual((await q(`SELECT id FROM subscription_usage WHERE subscription_id=$1 AND appointment_id=$2`, [F.sub, F.apptSub])).length, 0);
});

// ─────────── ПРЕДОПЛАТА ОНЛАЙН (Mono) — проверяем ТОЛЬКО наш зачёт, шлюз не трогаем ───────────
// Осторожно по требованию Босса: никаких обращений к API Mono, MONO_TOKEN у тестового
// сервера пуст. Предоплата кладётся прямо в бронь — так же, как её кладёт вебхук после
// успешной оплаты. Проверяем ровно то, что горело в аудите: деньги не считаются дважды.
test('касса: онлайн-предоплата вычитается из чека и помечается использованной', async (t) => {
  if (skipIf(t)) return;
  const id = await newAppointment(1000, 17);
  const starts = (await q(`SELECT starts_at FROM appointments WHERE id=$1`, [id]))[0].starts_at;
  F.booking = (await q(
    `INSERT INTO online_bookings (client_id, client_phone, service_id, service_name, date_from, date_to,
                                  channel, status, prepaid_amount, prepaid_at, tenant_id, note)
     VALUES ($1,'380990000117',$2,$3, $4::timestamptz - interval '30 min', $4::timestamptz + interval '30 min',
             'web','confirmed', 400, NOW(), $5, $6) RETURNING id`,
    [F.client, String(F.service), MARK, starts, TENANT, MARK]))[0].id;

  const r = await api('POST', `/api/schedule/appointments/${id}/pay`, { method: 'card' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.final, 600, 'в кассу идут только 600 — предоплаченные 400 не берём второй раз');
  const ops = await cashOps(id);
  assert.strictEqual(ops.length, 1); assert.strictEqual(ops[0].amount, 600);
  const b = (await q(`SELECT prepaid_consumed_at FROM online_bookings WHERE id=$1`, [F.booking]))[0];
  assert.ok(b.prepaid_consumed_at, 'предоплата помечена использованной');
  F.apptPrepaid = id;
});

test('касса: отмена оплаты снимает отметку с предоплаты (иначе повторная оплата берёт полную сумму)', async (t) => {
  if (skipIf(t)) return;
  const r = await api('POST', `/api/schedule/appointments/${F.apptPrepaid}/unpay`);
  assert.strictEqual(r.status, 200);
  const b = (await q(`SELECT prepaid_consumed_at FROM online_bookings WHERE id=$1`, [F.booking]))[0];
  assert.strictEqual(b.prepaid_consumed_at, null, 'отметка снята — предоплата снова в силе');
  const again = await api('POST', `/api/schedule/appointments/${F.apptPrepaid}/pay`, { method: 'card' });
  assert.strictEqual(again.body.final, 600, 'повторная оплата снова учитывает предоплату, а не берёт 1000');
  await api('POST', `/api/schedule/appointments/${F.apptPrepaid}/unpay`);
});
