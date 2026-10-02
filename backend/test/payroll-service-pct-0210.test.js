// Сторож 02.10 (Босс: «у Схемах ЗП ставити ОКРЕМИЙ % майстру за окремі послуги»).
// Правило payroll_rules (scope=service) = виняток поверх % схеми; ефективний % візиту =
// Σ(ціна рядка × %)/Σ(ціна) по робочих рядках (не матеріал); база візиту НЕ змінюється.
// Майстер X, схема 40% net; послуги Y(1000), Z(1000), матеріал M(300). Візити в різних місяцях 2020:
//   березень  — тільки Y               → без правила 400, з правилом Y=50% → 500 (50%)
//   квітень   — Y + Z                  → 800 → 900 (45%)
//   травень   — Y + матеріал M (1300)  → база 1000 як і раніше, 400 → 500
// Перевіряємо ВСІ шляхи: відомість (liveEstimate), «Підтвердження витрат», Фінцентр (live-finance +
// по майстрах), звіт по майстрах, «Розрахувати ЗП» (+видалення чернетки), кабінет майстра /payroll/my.
// Видалення правила → назад до 40%. Фікс-схема правил не бачить. API: %>100 → 400, чужа послуга → 404.
// БЕЗПЕКА: окремий сервер (дефолт :3050; ручний прогін 02.10 — SVCPCT_TEST_PORT=3037) поверх QA_DB_URL,
// фікстури QA-SVCPCT-0210 прибираються в after().
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.SVCPCT_TEST_PORT || 3050);
const QA_URL = process.env.QA_DB_URL;
const MARK = 'QA-SVCPCT-0210';
const MASTER_TOKEN = crypto.randomBytes(32).toString('hex');
const ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
let db, S;
const F = { svc: {}, appts: [], users: [], records: [] };

const q = async (sql, p) => (await db.query(sql, p)).rows;
const call = async (token, method, url, body) => {
  const res = await fetch(S.base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};
const own = (m, u, b) => call(S.token, m, u, b);
const MONTHS = ['2020-03', '2020-04', '2020-05'];
const last = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);

// усі шляхи розрахунку → { шлях: [сума за березень, квітень, травень] }
async function measure() {
  const mid = F.master, out = {};
  out.sheet = []; out.confirm = []; out.finTotal = []; out.finByMaster = []; out.repMasters = []; out.my = [];
  for (const ym of MONTHS) {
    const sh = await own('GET', `/api/payouts/sheet?period=${ym}&master_id=${mid}`);
    assert.strictEqual(sh.status, 200, JSON.stringify(sh.body));
    const row = (sh.body.items || sh.body.rows || []).find(r => String(r.master_id) === String(mid));
    out.sheet.push(row ? row.percent_part : null);
    const ec = await own('GET', `/api/expense-confirm/pending?from=${ym}-01&to=${last(ym)}`);
    const it = (ec.body.items || ec.body.salary || []).find ? (ec.body.items || []).find(i => i.kind === 'salary' && String(i.master_id) === String(mid)) : null;
    out.confirm.push(it ? it.services_part : null);
    const fd = await own('GET', `/api/financial/detail?from=${ym}-01&to=${last(ym)}`);
    const cm = (fd.body.expenses.commission_by_master || []).find(x => x.name === MARK + ' майстер');
    out.finTotal.push(Number(fd.body.expenses.commission_total)); // live-finance: ЗП всього салону за місяць
    out.finByMaster.push(cm ? cm.sum : 0);
    const rm = await own('GET', `/api/reports/masters?from=${ym}-01&to=${last(ym)}&fresh=1`);
    const rr = (rm.body.items || rm.body.masters || rm.body || []).find?.(x => String(x.id) === String(mid));
    out.repMasters.push(rr ? Number(rr.payroll_sum) : null);
    const my = await call(MASTER_TOKEN, 'GET', `/api/payroll/my?ym=${ym}`);
    assert.strictEqual(my.status, 200, JSON.stringify(my.body));
    out.my.push(my.body.current ? my.body.current.percent_part : null);
  }
  // «Розрахувати ЗП» за весь період (березень–травень), чернетку одразу видаляємо
  const c = await own('POST', '/api/payroll/calculate', { master_id: String(mid), period_start: '2020-03-01', period_end: '2020-05-31', force: true });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  F.records.push(c.body.record_id);
  out.calc = Math.round(c.body.breakdown.percent_part * 100) / 100;
  const d = await own('DELETE', `/api/payroll/records/${c.body.record_id}`);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  return out;
}
const expect = (o, per) => {
  const sum = per.reduce((a, b) => a + b, 0);
  assert.deepStrictEqual(o.sheet, per, 'відомість (liveEstimate)');
  assert.deepStrictEqual(o.confirm, per, 'Підтвердження витрат');
  assert.deepStrictEqual(o.finByMaster, per, 'Фінцентр по майстрах');
  assert.deepStrictEqual(o.repMasters, per, 'звіт по майстрах (нараховано)');
  assert.deepStrictEqual(o.my, per, 'кабінет майстра /payroll/my');
  assert.strictEqual(o.calc, sum, '«Розрахувати ЗП»');
};

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  F.master = (await q(`INSERT INTO masters (name, active, tenant_id) VALUES ($1, true, $2) RETURNING id`, [MARK + ' майстер', TENANT]))[0].id;
  F.foreignTenant = (await q(`SELECT id FROM tenants WHERE id<>$1 ORDER BY created_at LIMIT 1`, [TENANT]))[0]?.id;
  for (const [k, price, mat] of [['Y', 1000, false], ['Z', 1000, false], ['M', 300, true], ['FOREIGN', 100, false]]) {
    if (k === 'FOREIGN' && !F.foreignTenant) continue;
    F.svc[k] = (await q(`INSERT INTO services (name, duration_min, price, is_material, tenant_id) VALUES ($1,60,$2,$3,$4) RETURNING id`,
      [`${MARK} послуга ${k}`, price, mat, k === 'FOREIGN' ? F.foreignTenant : TENANT]))[0].id;
  }
  const visit = async (day, lines) => {
    const total = lines.reduce((a, [, p]) => a + p, 0);
    const id = (await q(`INSERT INTO appointments (master_id, service_id, starts_at, ends_at, status, price, real_amount, notes, tenant_id)
                         VALUES ($1,$2,$3::timestamptz,$3::timestamptz + INTERVAL '1 hour','done',$4,$4,$5,$6) RETURNING id`,
      [F.master, F.svc[lines[0][0]], day + ' 10:00:00+02', total, MARK, TENANT]))[0].id;
    for (const [k, p] of lines) {
      await q(`INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price, tenant_id)
               VALUES ($1,$2,$3,$4::timestamptz,60,$5,$6)`, [id, F.svc[k], F.master, day + ' 10:00:00+02', p, TENANT]);
    }
    F.appts.push(id);
  };
  await visit('2020-03-10', [['Y', 1000]]);
  await visit('2020-04-10', [['Y', 1000], ['Z', 1000]]);
  await visit('2020-05-10', [['Y', 1000], ['M', 300]]);
  // логін майстра (для /payroll/my)
  const role = (await q(`SELECT id FROM roles WHERE code='master' ORDER BY id LIMIT 1`))[0];
  const uid = (await q(`INSERT INTO users (display_name, role_id, is_active, master_id, tenant_id) VALUES ($1,$2,true,$3,$4) RETURNING id`,
    [MARK + ' логін', role.id, F.master, TENANT]))[0].id;
  F.users.push(uid);
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW() + INTERVAL '1 hour',$4)`,
    [uid, crypto.createHash('sha256').update(MASTER_TOKEN).digest('hex'), MARK, TENANT]);
  // адмін салону з правами ЗП (не платформний токен) — для перевірки «чужа послуга»
  const arole = (await q(`SELECT id FROM roles WHERE code='admin' ORDER BY id LIMIT 1`))[0];
  const aid = (await q(`INSERT INTO users (display_name, role_id, is_active, permissions_override, tenant_id) VALUES ($1,$2,true,$3::jsonb,$4) RETURNING id`,
    [MARK + ' адмін', arole.id, JSON.stringify(['payroll.read', 'payroll.write']), TENANT]))[0].id;
  F.users.push(aid);
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW() + INTERVAL '1 hour',$4)`,
    [aid, crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex'), MARK, TENANT]);
  S = await startQaServer({ port: PORT });
  const sc = await own('POST', '/api/payroll/schemes', { master_id: String(F.master), master_name: MARK + ' майстер', scheme_type: 'percent', percent: 40, percent_base: 'net' });
  assert.strictEqual(sc.status, 200, JSON.stringify(sc.body));
});

after(async () => {
  if (S) S.stop();
  if (!db) return;
  const ids = F.appts;
  await q(`DELETE FROM payroll_rules WHERE master_id=$1`, [F.master]).catch(() => {});
  await q(`DELETE FROM payroll_records WHERE master_id=$1`, [String(F.master)]).catch(() => {});
  await q(`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [ids]);
  await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]);
  await q(`DELETE FROM payroll_schemes WHERE master_id=$1`, [String(F.master)]);
  for (const u of F.users) {
    await q(`DELETE FROM user_tokens WHERE user_id=$1`, [u]);
    await q(`DELETE FROM audit_log WHERE user_id=$1`, [u]).catch(() => {});
    await q(`DELETE FROM users WHERE id=$1`, [u]);
  }
  await q(`DELETE FROM services WHERE id = ANY($1::int[])`, [Object.values(F.svc)]);
  await q(`DELETE FROM masters WHERE id=$1`, [F.master]);
  const left = await q(`SELECT (SELECT count(*) FROM masters WHERE name LIKE $1)::int m, (SELECT count(*) FROM services WHERE name LIKE $1)::int s,
                               (SELECT count(*) FROM appointments WHERE notes=$2)::int a`, [MARK + '%', MARK]);
  console.log('залишки фікстур:', JSON.stringify(left[0]));
  await db.end();
});

test('без правил: 40% у всіх шляхах (400/800/400), база з матеріалом не змінилась', { skip: !QA_URL }, async () => {
  const o = await measure();
  expect(o, [400, 800, 400]);
  F.finBase = o.finTotal;
});

test('правило Y=50%: Y→50%, Y+Z→45%, Y+матеріал→50% від тієї ж бази 1000', { skip: !QA_URL }, async () => {
  const r = await own('POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: String(F.svc.Y), percentage: 50 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  F.ruleY = r.body.rule.id;
  const o = await measure();
  expect(o, [500, 900, 500]);
  // Фінцентр (live-finance, ЗП усього салону): рівно +100 у кожному місяці
  assert.deepStrictEqual(o.finTotal.map((v, i) => Math.round((v - F.finBase[i]) * 100) / 100), [100, 100, 100], 'live-finance');
  // база (виручка послуг) не змінилась: травень — 1000 (1300 − матеріал 300)
  const ec = await own('GET', `/api/expense-confirm/pending?from=2020-05-01&to=2020-05-31`);
  const it = ec.body.items.find(i => i.kind === 'salary' && String(i.master_id) === String(F.master));
  assert.strictEqual(it.services_revenue, 1000);
  assert.strictEqual(it.materials_cost, 300);
});

test('два правила на одну послугу: діє менший priority (потім новіше)', { skip: !QA_URL }, async () => {
  const r = await own('POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: String(F.svc.Y), percentage: 60, priority: 200 });
  assert.strictEqual(r.status, 200);
  const sh = await own('GET', `/api/payouts/sheet?period=2020-03&master_id=${F.master}`);
  assert.strictEqual(sh.body.rows.find(x => String(x.master_id) === String(F.master)).percent_part, 500, 'priority 100 (50%) важливіший за 200 (60%)');
  const d = await own('DELETE', `/api/payouts/rules/${r.body.rule.id}`);
  assert.strictEqual(d.status, 200);
});

test('API: %>100 → 400, послуга іншого салону → 404, без входу → 401', { skip: !QA_URL }, async () => {
  const a = await own('POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: String(F.svc.Z), percentage: 150 });
  assert.strictEqual(a.status, 400);
  const b = await own('POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: '999999999', percentage: 30 });
  assert.strictEqual(b.status, 404);
  if (F.svc.FOREIGN) {
    const f = await call(ADMIN_TOKEN, 'POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: String(F.svc.FOREIGN), percentage: 30 });
    assert.strictEqual(f.status, 404, 'послуга іншого салону: ' + JSON.stringify(f.body));
    const ok = await call(ADMIN_TOKEN, 'GET', `/api/payouts/rules?master_id=${F.master}`);
    assert.strictEqual(ok.status, 200, 'адмін салону з payroll.read бачить правила');
  }
  const n = await fetch(S.base + '/api/payouts/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(n.status, 401);
  const m = await call(MASTER_TOKEN, 'POST', '/api/payouts/rules', { master_id: F.master, scope: 'service', scope_ref: String(F.svc.Z), percentage: 90 });
  assert.strictEqual(m.status, 403, 'майстер не може сам собі ставити %');
});

test('фікс-схема: правила не діють (нарахування % = 0)', { skip: !QA_URL }, async () => {
  const sc = await own('POST', '/api/payroll/schemes', { master_id: String(F.master), master_name: MARK + ' майстер', scheme_type: 'fixed', fixed_per_month: 1000, percent_base: 'net' });
  assert.strictEqual(sc.status, 200);
  const sh = await own('GET', `/api/payouts/sheet?period=2020-04&master_id=${F.master}`);
  assert.strictEqual(sh.body.rows.find(x => String(x.master_id) === String(F.master)).percent_part, 0);
  const back = await own('POST', '/api/payroll/schemes', { master_id: String(F.master), master_name: MARK + ' майстер', scheme_type: 'percent', percent: 40, percent_base: 'net' });
  assert.strictEqual(back.status, 200);
});

test('видалення правила → знову 40% у всіх шляхах', { skip: !QA_URL }, async () => {
  const d = await own('DELETE', `/api/payouts/rules/${F.ruleY}`);
  assert.strictEqual(d.status, 200);
  const o = await measure();
  expect(o, [400, 800, 400]);
  assert.deepStrictEqual(o.finTotal, F.finBase, 'live-finance повернувся до бази');
});

test('звіт власника: прогноз ЗП на 7 днів бачить окремий % (майбутній візит Y 1000: 400 → 500)', { skip: !QA_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: QA_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  const { buildDailyReport } = require('../lib/owner-report');
  const fut = (await q(`INSERT INTO appointments (master_id, service_id, starts_at, ends_at, status, price, notes, tenant_id)
                        VALUES ($1,$2,NOW() + INTERVAL '2 days',NOW() + INTERVAL '2 days 1 hour','confirmed',1000,$3,$4) RETURNING id`,
    [F.master, F.svc.Y, MARK, TENANT]))[0].id;
  F.appts.push(fut);
  await q(`INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price, tenant_id)
           VALUES ($1,$2,$3,NOW() + INTERVAL '2 days',60,1000,$4)`, [fut, F.svc.Y, F.master, TENANT]);
  try {
    const before = (await buildDailyReport(pool, TENANT, null)).forecast.commission;
    const r = await own('POST', '/api/payouts/rules', { master_id: F.master, rule_type: 'percent_service', scope: 'service', scope_ref: String(F.svc.Y), percentage: 50 });
    assert.strictEqual(r.status, 200);
    const withRule = (await buildDailyReport(pool, TENANT, null)).forecast.commission;
    await own('DELETE', `/api/payouts/rules/${r.body.rule.id}`);
    const back = (await buildDailyReport(pool, TENANT, null)).forecast.commission;
    assert.strictEqual(withRule - before, 100, `прогноз: ${before} → ${withRule}`);
    assert.strictEqual(back, before);
  } finally { await pool.end(); }
});
