// Картка клієнта → деталь візиту + формули фарбування до візиту (Босс 04.11, client-visit-0411).
// QA-пісочниця (QA_DB_URL), окремий сервер :3073.
//  • GET /api/admin/visits/:id — усі послуги візиту (appointment_services з цінами), матеріали, каса, формула;
//  • POST /api/medical/formulas з appointment_id — клієнт/дата/майстер беруться з візиту, чужий клієнт → 400, нема візиту → 404;
//  • формула заднім числом не забирає «поточну» в новішої;
//  • GET /api/medical/formulas/history/:client_id і ?appointment_id= ; GET /api/admin/clients/:id → has_formula.
// Фікстури помічені QA-CVD-TEST і прибираються в after() (лише QA-база, лише створені тут id).
require('dotenv').config();
const QA_URL = process.env.QA_DB_URL;
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-000000000001';
const PORT = Number(process.env.CVD_TEST_PORT || 3073);
const MARK = 'QA-CVD-TEST';

let db, S;
const F = { appts: [], clients: [], masters: [], services: [] };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const skipIf = (t) => { if (!QA_URL) { t.skip('нема QA_DB_URL'); return true; } return false; };

async function admin(method, url, body) {
  const res = await fetch(S.base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function client(name) {
  const phone = '3809' + String(Date.now() % 1000000).padStart(6, '0') + String(F.clients.length);
  const id = (await q(`INSERT INTO clients (name, phone, tenant_id, source) VALUES ($1,$2,$3,'qa-test') RETURNING id`,
    [name, phone, TENANT]))[0].id;
  F.clients.push(id); return id;
}
async function service(name, price) {
  const id = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,$2,true,$3) RETURNING id`,
    [name, price, TENANT]))[0].id;
  F.services.push(id); return id;
}
const kyivTs = (shiftExpr, hour) => `((((now() AT TIME ZONE 'Europe/Kyiv')::date + ${shiftExpr}) + time '${hour}') AT TIME ZONE 'Europe/Kyiv')`;
async function visit(clientId, dayShift, serviceId) {
  const id = (await q(
    `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
     VALUES ($1,$2,$3, ${kyivTs('$4::int', '11:00')}, ${kyivTs('$4::int', '14:00')}, 'done', 2300, $5, 'qa-test', $6) RETURNING id`,
    [clientId, F.master, serviceId, dayShift, TENANT, MARK + ' нотатка візиту']))[0].id;
  F.appts.push(id); return id;
}

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  S = await startQaServer({ port: PORT });
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`,
    [MARK + ' майстер', TENANT]))[0].id;
  F.masters.push(F.master);
  F.svcColor = await service(MARK + ' Фарбування коренів', 1500);
  F.svcCut = await service(MARK + ' Стрижка', 800);
  F.client = await client(MARK + ' клієнтка');
  F.other = await client(MARK + ' інша');
  F.old = await visit(F.client, -40, F.svcColor);   // давній візит — формулу внесемо заднім числом
  F.appt = await visit(F.client, -5, F.svcColor);   // свіжий візит: дві послуги
  for (const [sid, price, h] of [[F.svcColor, 1500, '11:00'], [F.svcCut, 800, '13:00']]) {
    await q(`INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price, tenant_id)
             VALUES ($1,$2,$3, ${kyivTs('-5', h)}, 60, $4, $5)`, [F.appt, sid, F.master, price, TENANT]);
  }
  // матеріал зі складу — якщо в QA є хоч один варіант товару
  const v = (await q(`SELECT id FROM product_variants WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [TENANT]))[0];
  if (v) {
    F.variant = v.id;
    await q(`INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, billable, note, tenant_id)
             VALUES ($1,$2,30,false,$3,$4)`, [F.appt, v.id, MARK, TENANT]);
  }
}, { timeout: 180000 });

after(async () => {
  if (S) S.stop();
  if (!db) return;
  const steps = [
    ['formulas', `DELETE FROM coloring_formulas WHERE client_id = ANY($1::int[])`, [F.clients]],
    ['materials', `DELETE FROM appointment_materials WHERE appointment_id = ANY($1::int[])`, [F.appts]],
    ['appt_services', `DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [F.appts]],
    ['appointments', `DELETE FROM appointments WHERE id = ANY($1::int[])`, [F.appts]],
    ['services', `DELETE FROM services WHERE id = ANY($1::int[])`, [F.services]],
    ['masters', `DELETE FROM masters WHERE id = ANY($1::int[])`, [F.masters]],
    ['clients', `DELETE FROM clients WHERE id = ANY($1::int[])`, [F.clients]],
  ];
  for (const [name, sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', name, e.message); } }
  await db.end();
}, { timeout: 60000 });

const ZONES = [
  { zone: 'Корінь', brand: 'Wella Koleston', shade: '6/0', amount_g: 30, oxidant_pct: 6, time_min: 35 },
  { zone: 'Корінь', brand: 'Wella Koleston', shade: '7/1', amount_g: 30, oxidant_pct: 6, time_min: 35 },
  { zone: 'Довжина', brand: 'Wella Color Touch', shade: '8/71', amount_g: 40, oxidant_pct: 1.9, time_min: 20 },
];

test('формула до візиту: клієнт, дата, майстер і послуга беруться з запису', async (t) => {
  if (skipIf(t)) return;
  const r = await admin('POST', '/api/medical/formulas', { appointment_id: F.appt, zones: ZONES, total_amount_g: 100, result_notes: MARK + ' рівно лягло' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const f = r.body.formula; F.fNew = f.id;
  assert.strictEqual(f.client_id, F.client, 'client_id підставлено з візиту');
  assert.strictEqual(f.appointment_id, F.appt);
  assert.strictEqual(f.service_id, F.svcColor);
  assert.strictEqual(f.employee_name, MARK + ' майстер', 'майстер — з візиту');
  assert.strictEqual(f.is_current, true);
  const visitDay = (await q(`SELECT ((starts_at AT TIME ZONE 'Europe/Kyiv')::date)::text d FROM appointments WHERE id=$1`, [F.appt]))[0].d;
  assert.strictEqual((await q(`SELECT formula_date::text d FROM coloring_formulas WHERE id=$1`, [f.id]))[0].d, visitDay, 'дата формули = день візиту');
  assert.strictEqual(f.zones.length, 3);
  assert.deepStrictEqual([f.zones[2].shade, f.zones[2].oxidant_pct, f.zones[2].amount_g], ['8/71', 1.9, 40]);
});

test('формула заднім числом не забирає «поточну» в свіжої', async (t) => {
  if (skipIf(t)) return;
  const r = await admin('POST', '/api/medical/formulas', { appointment_id: F.old, client_id: F.client,
    zones: [{ zone: 'Корінь', brand: 'Wella Koleston', shade: '6/0', amount_g: 60, oxidant_pct: 9, time_min: 40 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  F.fOld = r.body.formula.id;
  assert.strictEqual(r.body.formula.is_current, false, 'давня формула не стає поточною');
  const cur = (await q(`SELECT id FROM coloring_formulas WHERE client_id=$1 AND is_current`, [F.client])).map(x => x.id);
  assert.deepStrictEqual(cur, [F.fNew], 'поточна лишилась свіжа');
});

test('захист прив\'язки: чужий клієнт → 400, неіснуючий візит → 404', async (t) => {
  if (skipIf(t)) return;
  const a = await admin('POST', '/api/medical/formulas', { appointment_id: F.appt, client_id: F.other, zones: ZONES });
  assert.strictEqual(a.status, 400, JSON.stringify(a.body));
  const b = await admin('POST', '/api/medical/formulas', { appointment_id: 2147480000, zones: ZONES });
  assert.strictEqual(b.status, 404, JSON.stringify(b.body));
  const n = (await q(`SELECT COUNT(*)::int n FROM coloring_formulas WHERE client_id = ANY($1::int[])`, [[F.client, F.other]]))[0].n;
  assert.strictEqual(n, 2, 'відхилені запити нічого не записали');
});

test('історія формул клієнта: новіша перша; фільтр по візиту', async (t) => {
  if (skipIf(t)) return;
  const h = await admin('GET', `/api/medical/formulas/history/${F.client}`);
  assert.strictEqual(h.status, 200, JSON.stringify(h.body));
  assert.deepStrictEqual(h.body.items.map(x => x.id), [F.fNew, F.fOld]);
  const byAppt = await admin('GET', `/api/medical/formulas?appointment_id=${F.old}`);
  assert.strictEqual(byAppt.status, 200, JSON.stringify(byAppt.body));
  assert.deepStrictEqual(byAppt.body.items.map(x => x.id), [F.fOld]);
});

test('редагування формули (PATCH): відтінок змінюється, прив\'язка лишається', async (t) => {
  if (skipIf(t)) return;
  const z = ZONES.map(x => ({ ...x })); z[0].shade = '6/1'; z[0].oxidant_pct = 9;
  const r = await admin('PATCH', `/api/medical/formulas/${F.fNew}`, { zones: z, result_notes: MARK + ' виправлено' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.formula.zones[0].shade, '6/1');
  assert.strictEqual(r.body.formula.appointment_id, F.appt);
});

test('деталь візиту: усі послуги з цінами, матеріали, нотатки і формула', async (t) => {
  if (skipIf(t)) return;
  const r = await admin('GET', `/api/admin/visits/${F.appt}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const v = r.body.visit;
  assert.strictEqual(v.client_id, F.client);
  assert.strictEqual(v.master_name, MARK + ' майстер');
  assert.strictEqual(v.notes, MARK + ' нотатка візиту');
  assert.deepStrictEqual(v.services.map(s => [s.name, Number(s.price)]), [[MARK + ' Фарбування коренів', 1500], [MARK + ' Стрижка', 800]]);
  if (F.variant) {
    assert.strictEqual(v.materials.length, 1);
    assert.deepStrictEqual([v.materials[0].qty, v.materials[0].billable], [30, false]);
  }
  assert.deepStrictEqual(v.formulas.map(f => f.id), [F.fNew]);
  assert.strictEqual(v.formulas[0].zones[0].shade, '6/1');
  const none = await admin('GET', '/api/admin/visits/2147480000');
  assert.strictEqual(none.status, 404);
});

test('картка клієнта: у візитів є id, services_text і позначка has_formula', async (t) => {
  if (skipIf(t)) return;
  const r = await admin('GET', `/api/admin/clients/${F.client}`);
  assert.strictEqual(r.status, 200, 'статус ' + r.status);
  const vs = r.body.client.visits;
  const fresh = vs.find(v => v.id === F.appt), old = vs.find(v => v.id === F.old);
  assert.ok(fresh && old, 'обидва візити в картці');
  assert.strictEqual(fresh.has_formula, true);
  assert.strictEqual(old.has_formula, true);
  assert.match(fresh.services_text || '', /Фарбування коренів/);
  assert.match(fresh.services_text || '', /Стрижка/);
});
