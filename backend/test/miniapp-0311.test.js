// Telegram Mini App онлайн-запису (Босс 03.11). Перевіряє на QA (окремий сервер :3055 поверх QA_DB_URL):
//  • initData: без підпису / з чужим підписом / прострочений → 401; правильний → 200;
//  • телефон один раз: без телефону бронь → 412; підписаний requestContact чужого user_id → 400;
//  • бронь: запис у appointments(source=miniapp) + тінь online_bookings(channel=miniapp);
//  • подвійний тап (2 паралельні POST) = ОДНА бронь; другий клієнт на той самий слот → 409 «Час щойно зайняли»;
//  • два різні клієнти одночасно на один слот → рівно одна бронь;
//  • порожній день → slots=[]; remind24=false → 24h позначено як оброблене;
//  • кабінет: /my, перенос (move_ids → старий cancelled, новий confirmed), скасування; чужий запис не скасувати.
// Фікстури: клієнти з telegram_id 77xxxxxxxx (лише ті, що створив тест), прибираються в after.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');
const { sign } = require('../lib/tg-initdata');

const PORT = Number(process.env.MINIAPP_TEST_PORT || 3055);
const BASE = `http://127.0.0.1:${PORT}`;
const QA_URL = process.env.QA_DB_URL;
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex'); // фейковий токен — лише для підпису
const now = () => Math.floor(Date.now() / 1000);
const uids = [];
function mkUser() { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: 'QA Міні', username: 'qa_mini_' + id }; }
const initFor = (user, authDate = now(), token = BOT) => sign({ auth_date: authDate, query_id: 'AAq' + user.id, user }, token);
const phone = () => '+38099' + String(Math.floor(1e6 + Math.random() * 8.9e6));

let db, S;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function call(init, method, url, body) {
  const res = await fetch(BASE + '/api/miniapp' + url, { method,
    headers: { 'Content-Type': 'application/json', ...(init != null ? { 'X-Telegram-Init-Data': init } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
// клієнт з телефоном (ручний ввід нового номера)
async function readyUser() {
  const u = mkUser(); const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { phone: phone(), name: 'QA Міні ' + String(u.id).slice(-4) });
  assert.strictEqual(r.status, 200, 'contact: ' + JSON.stringify(r.body));
  return { u, init };
}

// У QA-копії графіки майстрів закінчуються в минулому → тест сам дає ОДНОМУ майстру графік на 3 дні вперед
// (source='qa-miniapp-0311', лише на дати, де в нього графіка немає), 4-й день лишається порожнім. Прибирається в after.
const FIX_SRC = 'qa-miniapp-0311';
let PICK = null;
async function setupFixture() {
  const u = mkUser(); const init = initFor(u);
  const cat = await call(init, 'GET', '/catalog');
  assert.strictEqual(cat.status, 200, 'catalog');
  const svcs = cat.body.categories.flatMap(c => c.services).filter(s => Number(s.duration_min) >= 30 && Number(s.duration_min) <= 90);
  for (const s of svcs) {
    const ms = await call(init, 'GET', '/masters?service=' + s.id);
    const m = (ms.body.masters || [])[0]; if (!m) continue;
    const d0 = (await q(`SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date + 2)::text d`))[0].d;
    const busy = await q(`SELECT 1 FROM master_schedule_days WHERE master_id=$1 AND work_date BETWEEN $2::date AND $2::date + 3`, [m.id, d0]);
    if (busy.length) continue;
    await q(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, tenant_id, source)
             SELECT $1, $2::date + i, '10:00', '18:00', $3, $4 FROM generate_series(0,2) i`, [m.id, d0, '00000000-0000-0000-0000-000000000001', FIX_SRC]);
    const date = d0;
    const emptyDay = (await q(`SELECT ($1::date + 3)::text d`, [d0]))[0].d;
    const sl = await call(init, 'GET', `/slots?service=${s.id}&master=${m.id}&date=${date}`);
    PICK = { svc: s, master: m, date, slots: sl.body.slots || [], emptyDay };
    if (PICK.slots.length < 4) throw new Error('після фікстури графіка слотів замало: ' + PICK.slots.length);
    return;
  }
  throw new Error('у QA немає послуги 30–90 хв з майстром без графіка на ці дні');
}
async function pickSlots() { if (!PICK) await setupFixture(); return PICK; }

before(async () => {
  if (!QA_URL) return;
  db = new Client({ connectionString: QA_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
}, { timeout: 150000 });

after(async () => {
  if (S) { const errs = S.log().split('\n').filter(l => /\[miniapp|booking-core|Error/.test(l)); if (errs.length) console.error('server log:\n' + errs.slice(-20).join('\n')); S.stop(); }
  if (!db) return;
  await q(`DELETE FROM master_schedule_days WHERE source=$1`, [FIX_SRC]).catch(e => console.error('cleanup sched', e.message));
  if (uids.length) {
    const cl = (await q(`SELECT id FROM clients WHERE telegram_id = ANY($1::bigint[])`, [uids])).map(r => r.id);
    if (cl.length) {
      const ap = (await q(`SELECT id FROM appointments WHERE client_id = ANY($1::int[])`, [cl])).map(r => r.id);
      if (ap.length) {
        await q(`DELETE FROM booking_reminders WHERE appointment_id = ANY($1::int[])`, [ap]).catch(() => {});
        await q(`DELETE FROM online_bookings WHERE appointment_id = ANY($1::int[]) OR legacy_appointment_ref = ANY($2::text[])`, [ap, ap.map(String)]).catch(e => console.error('cleanup ob', e.message));
        await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ap]).catch(e => console.error('cleanup ap', e.message));
      }
      await q(`DELETE FROM clients WHERE id = ANY($1::int[])`, [cl]).catch(e => console.error('cleanup cl', e.message));
    }
  }
  await db.end();
});

test('initData: без підпису / чужий підпис / прострочений → 401, правильний → 200', { skip: !QA_URL }, async () => {
  const u = mkUser();
  assert.strictEqual((await call(null, 'GET', '/me')).status, 401, 'без заголовка');
  const unsigned = new URLSearchParams({ auth_date: String(now()), user: JSON.stringify(u) }).toString();
  const r1 = await call(unsigned, 'GET', '/me'); assert.strictEqual(r1.status, 401); assert.strictEqual(r1.body.reason, 'no_hash');
  const r2 = await call(initFor(u, now(), '7000000001:INSHYI-BOT'), 'GET', '/me'); assert.strictEqual(r2.status, 401); assert.strictEqual(r2.body.reason, 'bad_hash');
  const r3 = await call(initFor(u, now() - 25 * 3600), 'GET', '/me'); assert.strictEqual(r3.status, 401); assert.strictEqual(r3.body.reason, 'expired');
  // підроблений user при правильному hash іншого → bad_hash
  const good = initFor(u); const tampered = good.replace(encodeURIComponent(String(u.id)), encodeURIComponent(String(u.id + 1)));
  assert.strictEqual((await call(tampered, 'GET', '/me')).status, 401, 'підміна user');
  const ok = await call(good, 'GET', '/me'); assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.client, null);
  assert.strictEqual((await call(unsigned, 'GET', '/my')).status, 401, 'кабінет без підпису');
  assert.strictEqual((await call(unsigned, 'POST', '/book', { service_id: 1 })).status, 401, 'бронь без підпису');
});

test('телефон: без нього бронь → 412; чужий requestContact → 400; свій підписаний → 200', { skip: !QA_URL }, async () => {
  const u = mkUser(); const init = initFor(u);
  const P = await pickSlots(init);
  const nb = await call(init, 'POST', '/book', { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: P.slots[0].start_min });
  assert.strictEqual(nb.status, 412); assert.strictEqual(nb.body.error, 'need_phone');
  const ph = phone().replace('+', '');
  const foreign = sign({ contact: { user_id: u.id + 1, phone_number: ph, first_name: 'X' }, auth_date: now() }, BOT);
  assert.strictEqual((await call(init, 'POST', '/contact', { contact: foreign })).status, 400);
  const forged = sign({ contact: { user_id: u.id, phone_number: ph }, auth_date: now() }, 'інший-токен');
  assert.strictEqual((await call(init, 'POST', '/contact', { contact: forged })).status, 401);
  const own = sign({ contact: { user_id: u.id, phone_number: ph, first_name: 'QA' }, auth_date: now() }, BOT);
  const r = await call(init, 'POST', '/contact', { contact: own }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const me = await call(init, 'GET', '/me'); assert.strictEqual(me.body.client.has_phone, true);
  const row = (await q(`SELECT source FROM clients WHERE telegram_id=$1`, [u.id]))[0];
  assert.strictEqual(row.source, 'miniapp');
  assert.strictEqual((await call(init, 'POST', '/contact', { phone: '+38050', name: 'x' })).status, 400, 'кривий номер');
});

test('бронь + подвійний тап = одна; другий клієнт на той самий слот → 409 «Час щойно зайняли»', { skip: !QA_URL }, async () => {
  const A = await readyUser(); const B = await readyUser();
  const P = await pickSlots(A.init); const slot = P.slots[0];
  const body = { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: slot.start_min, remind24: false };
  const [r1, r2] = await Promise.all([call(A.init, 'POST', '/book', body), call(A.init, 'POST', '/book', body)]);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body)); assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.deepStrictEqual(r1.body.booking.ids, r2.body.booking.ids, 'той самий запис');
  // третій тап після закриття вікна подвійного тапу (3 с) — dedupe в БД повертає той самий запис, не новий
  await new Promise(r => setTimeout(r, 3300));
  const r3 = await call(A.init, 'POST', '/book', body);
  assert.strictEqual(r3.status, 200, JSON.stringify(r3.body)); assert.strictEqual(r3.body.booking.existing, true);
  assert.deepStrictEqual(r3.body.booking.ids, r1.body.booking.ids);
  const rows = await q(`SELECT a.id, a.source, a.status FROM appointments a JOIN clients c ON c.id=a.client_id WHERE c.telegram_id=$1`, [A.u.id]);
  assert.strictEqual(rows.length, 1, 'рівно одна бронь'); assert.strictEqual(rows[0].source, 'miniapp');
  const ob = await q(`SELECT channel, status FROM online_bookings WHERE appointment_id=$1`, [rows[0].id]);
  assert.strictEqual(ob.length, 1); assert.strictEqual(ob[0].channel, 'miniapp');
  const rem = await q(`SELECT kind FROM booking_reminders WHERE appointment_id=$1`, [rows[0].id]);
  assert.deepStrictEqual(rem.map(x => x.kind), ['24h'], 'remind24=false → 24h позначено, 2h лишається');
  const rb = await call(B.init, 'POST', '/book', body);
  assert.strictEqual(rb.status, 409); assert.strictEqual(rb.body.error, 'slot_taken');
  assert.strictEqual(rb.body.message, 'Час щойно зайняли, оберіть інший');
  // зайнятий слот зник зі списку
  const after = await call(B.init, 'GET', `/slots?service=${P.svc.id}&master=${P.master.id}&date=${P.date}`);
  assert.ok(!after.body.slots.some(s => s.start_min === slot.start_min), 'слот більше не пропонується');
});

test('два різні клієнти одночасно на один слот → рівно одна бронь', { skip: !QA_URL }, async () => {
  const A = await readyUser(); const B = await readyUser();
  const P = await pickSlots(A.init);
  const fresh = await call(A.init, 'GET', `/slots?service=${P.svc.id}&master=${P.master.id}&date=${P.date}`);
  const slot = fresh.body.slots[fresh.body.slots.length - 1];
  const body = { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: slot.start_min };
  const rs = await Promise.all([call(A.init, 'POST', '/book', body), call(B.init, 'POST', '/book', body)]);
  const st = rs.map(r => r.status).sort();
  assert.deepStrictEqual(st, [200, 409], JSON.stringify(rs.map(r => r.body)));
  const n = await q(`SELECT count(*)::int n FROM appointments a JOIN clients c ON c.id=a.client_id
                      WHERE c.telegram_id = ANY($1::bigint[]) AND a.master_id=$2 AND a.status<>'cancelled'
                        AND a.starts_at = ((($3::date + make_interval(mins => $4)))::timestamp AT TIME ZONE 'Europe/Kyiv')`,
    [[A.u.id, B.u.id], P.master.id, P.date, slot.start_min]);
  assert.strictEqual(n[0].n, 1);
});

test('порожній день → slots=[] (у UI «вільного часу немає»)', { skip: !QA_URL }, async (t) => {
  const u = mkUser(); const init = initFor(u);
  const P = await pickSlots(init);
  if (!P.emptyDay) { t.skip('у 14 днях немає дня без слотів у цього майстра'); return; }
  const r = await call(init, 'GET', `/slots?service=${P.svc.id}&master=${P.master.id}&date=${P.emptyDay}`);
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.slots, []);
  assert.strictEqual((await call(init, 'GET', `/slots?service=${P.svc.id}&master=${P.master.id}&date=2020-01-01`)).status, 400, 'минула дата');
});

test('кабінет: перенос (старий скасовано, новий є) і скасування; чужий запис не чіпаємо', { skip: !QA_URL }, async () => {
  const A = await readyUser(); const B = await readyUser();
  const P = await pickSlots(A.init);
  const fresh = (await call(A.init, 'GET', `/slots?service=${P.svc.id}&master=${P.master.id}&date=${P.date}`)).body.slots;
  assert.ok(fresh.length >= 2, 'потрібно 2 вільні слоти');
  const b1 = await call(A.init, 'POST', '/book', { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: fresh[0].start_min });
  assert.strictEqual(b1.status, 200, JSON.stringify(b1.body));
  const oldIds = b1.body.booking.ids;
  const my = await call(A.init, 'GET', '/my');
  assert.strictEqual(my.status, 200); assert.ok(my.body.upcoming.some(a => oldIds.includes(a.id)), 'запис видно в кабінеті');
  // чужий клієнт не може ні перенести, ні скасувати
  assert.strictEqual((await call(B.init, 'GET', '/move-info?ids=' + oldIds.join(','))).status, 404);
  assert.strictEqual((await call(B.init, 'POST', '/cancel', { ids: oldIds })).status, 404);
  const mi = await call(A.init, 'GET', '/move-info?ids=' + oldIds.join(','));
  assert.strictEqual(mi.status, 200); assert.strictEqual(mi.body.service_id, P.svc.id);
  const target = fresh.find(s => s.start_min >= fresh[0].start_min + (P.svc.duration_min || 60)) || fresh[fresh.length - 1];
  const mv = await call(A.init, 'POST', '/book', { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: target.start_min, move_ids: oldIds });
  assert.strictEqual(mv.status, 200, JSON.stringify(mv.body)); assert.strictEqual(mv.body.booking.moved, true);
  const old = await q(`SELECT status FROM appointments WHERE id = ANY($1::int[])`, [oldIds]);
  assert.ok(old.every(r => r.status === 'cancelled'), 'старий скасовано');
  const obOld = await q(`SELECT status FROM online_bookings WHERE legacy_appointment_ref = ANY($1::text[])`, [oldIds.map(String)]);
  assert.ok(obOld.every(r => r.status === 'cancelled'), 'дзеркало скасовано');
  const newIds = mv.body.booking.ids;
  // повторний перенос уже скасованого → 409 move_gone
  const again = await call(A.init, 'POST', '/book', { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: fresh[0].start_min, move_ids: oldIds });
  assert.strictEqual(again.status, 409); assert.strictEqual(again.body.error, 'move_gone');
  const cn = await call(A.init, 'POST', '/cancel', { ids: newIds });
  assert.strictEqual(cn.status, 200, JSON.stringify(cn.body));
  const nw = await q(`SELECT status, cancelled_at FROM appointments WHERE id = ANY($1::int[])`, [newIds]);
  assert.ok(nw.every(r => r.status === 'cancelled' && r.cancelled_at), 'новий скасовано');
  const my2 = await call(A.init, 'GET', '/my');
  assert.strictEqual(my2.body.upcoming.length, 0);
});

test('каталог і майстри: аватари без Render, рейтинг лише за реальними відгуками', { skip: !QA_URL }, async () => {
  const u = mkUser(); const init = initFor(u);
  const cat = await call(init, 'GET', '/catalog');
  assert.ok(cat.body.categories.length > 0);
  const all = await call(init, 'GET', '/masters');
  assert.strictEqual(all.status, 200);
  for (const m of all.body.masters) {
    assert.ok(!m.avatar || /^\/api\/files\/[0-9a-f-]{36}$/i.test(m.avatar), 'аватар відносний: ' + m.avatar);
    if (m.rating != null) assert.ok(m.reviews > 0);
  }
  assert.ok(!JSON.stringify(all.body).includes('onrender.com'), 'жодного Render');
});

test('сторінка /p/app.html: 200, дозволено вбудовування лише в Telegram', { skip: !QA_URL }, async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/p/app.html`);
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('telegram-web-app.js') && html.includes('Записатися'));
  assert.ok(!html.includes('onrender.com'));
  assert.strictEqual(r.headers.get('x-frame-options'), null);
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors[^;]*telegram\.org/);
});
