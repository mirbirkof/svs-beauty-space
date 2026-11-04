// Фінальний незалежний аудит 04.11 — наскрізні сценарії мініапу на QA-базі (НЕ прод).
// Покриває те, чого нема в _miniapp-audit-0411 / _miniapp-visual-0411: бронь→журнал CRM→скасування,
// подвійний тап, два клієнти на один слот, rate-limit /book, майстер за номером → кабінет → «Забрати доступ» /
// звільнення, рахунок з товаром = формула каси, захоплення номера, перебір номерів через /contact.
// Запуск: node test/_final-audit-0411-e2e.js  (лише QA_DB_URL; все створене має мітку qa-audit і прибирається)
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = Number(process.env.AUD_PORT || 3083);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'final-audit-0411');
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const now = () => Math.floor(Date.now() / 1000);
const uids = []; const clientIds = []; const apptIds = [];
let qaMasterId = null; let seededSched = []; let restoreMasterTg = null;
const mkUser = (n) => { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_fa_' + id }; };
const initFor = (u) => sign({ auth_date: now(), query_id: 'AAf' + u.id, user: u }, BOT);
const contactFor = (u, phone) => sign({ auth_date: now(), contact: JSON.stringify({ user_id: u.id, phone_number: phone, first_name: u.first_name }) }, BOT);
const rndPhone = () => '+38067' + String(1e6 + Math.floor(Math.random() * 8.9e6));
const last9 = (p) => (String(p).replace(/\D/g, '').match(/\d{9}$/) || [''])[0];
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };
const note = (name, extra) => { results.push({ name, pass: null, extra }); console.log('• ' + name + ' — ' + extra); };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
let db, S, PROBE;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function api(u, method, url, body) {
  const h = { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initFor(u) };
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: h, body: body ? J(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function admin(method, url, body, token = S.token) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? J(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function withPhone(u, phone) {
  const r = await api(u, 'POST', '/contact', { contact: contactFor(u, phone) });
  if (r.status !== 200) throw new Error('contact ' + r.status + ' ' + J(r.body));
  return r;
}
async function pickSlot(svc, master, skip = 0) {
  const d = await api(PROBE, 'GET', `/days?service=${svc}&master=${master}&n=14`);
  for (const day of (d.body && d.body.days) || []) {
    if (!day.count) continue;
    const s = await api(PROBE, 'GET', `/slots?service=${svc}&master=${master}&date=${day.date}`);
    const sl = (s.body && s.body.slots) || [];
    if (sl.length > skip) { const x = sl[sl.length - 1 - skip]; return { date: day.date, start_min: x.start_min, label: x.label }; }
  }
  return null;
}
const countRe = (s, re) => (s.match(re) || []).length;

// ── 1. Новий клієнт → номер → запис → журнал CRM → «Мої записи» → скасування; подвійний тап ──
async function newClientBooking(ms) {
  const U = mkUser('QA-FA Нова'); const ph = rndPhone();
  const me0 = await api(U, 'GET', '/me');
  ok('новий клієнт: /me без картки', me0.status === 200 && !me0.body.client, J(me0.body && me0.body.client));
  await withPhone(U, ph);
  const c = (await q(`SELECT id, phone, telegram_id FROM clients WHERE telegram_id=$1`, [U.id]))[0];
  if (c) clientIds.push(c.id);
  ok('номер з Telegram → картка CRM з цим номером і TG', c && last9(c.phone) === last9(ph));
  const slot = await pickSlot(ms.service_id, ms.master_id);
  if (!slot) { ok('є вільний слот на 14 днів', false); return null; }
  const body = { service_id: ms.service_id, master_id: ms.master_id, date: slot.date, start_min: slot.start_min };
  const [b1, b2] = await Promise.all([api(U, 'POST', '/book', body), api(U, 'POST', '/book', body)]);
  ok('бронь: 200', b1.status === 200 && b1.body.ok, b1.status + ' ' + J(b1.body));
  const ids = (b1.body && b1.body.booking && b1.body.booking.ids) || [];
  apptIds.push(...ids);
  const rows = await q(`SELECT a.id, a.master_id, a.service_id, a.price::float, a.status, a.source,
      to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD HH24:MI') AS kyiv FROM appointments a WHERE client_id=$1 AND status IN ('booked','confirmed')`, [c.id]);
  ok('подвійний тап → у журналі ОДИН запис', rows.length === 1 && b2.status === 200 && J((b2.body.booking || {}).ids) === J(ids), `записів ${rows.length}, другий тап ${b2.status}`);
  const r = rows[0] || {};
  const svc = (await q(`SELECT price::float, duration_min FROM services WHERE id=$1`, [ms.service_id]))[0];
  const hh = String(Math.floor(slot.start_min / 60)).padStart(2, '0') + ':' + String(slot.start_min % 60).padStart(2, '0');
  ok('журнал CRM: правильний майстер', Number(r.master_id) === Number(ms.master_id), `${r.master_id} vs ${ms.master_id}`);
  ok('журнал CRM: правильні дата/час (Київ)', r.kyiv === `${slot.date} ${hh}`, `${r.kyiv} vs ${slot.date} ${hh}`);
  ok('журнал CRM: правильна ціна', Number(r.price) === Number(svc.price) && Number(b1.body.booking.price) === Number(svc.price), `${r.price} / відповідь ${b1.body.booking && b1.body.booking.price} / послуга ${svc.price}`);
  ok('журнал CRM: джерело miniapp', r.source === 'miniapp', r.source);
  const ob = await q(`SELECT id FROM online_bookings WHERE client_id=$1`, [c.id]);
  ok('онлайн-заявка створена (як у бота)', ob.length >= 1, 'online_bookings ' + ob.length);
  await pause(3500);
  const b3 = await api(U, 'POST', '/book', body);
  const cnt3 = (await q(`SELECT count(*)::int n FROM appointments WHERE client_id=$1 AND status IN ('booked','confirmed')`, [c.id]))[0].n;
  ok('повторний тап через 3.5 с → той самий запис', b3.status === 200 && b3.body.booking.existing === true && cnt3 === 1, `${b3.status} existing=${b3.body && b3.body.booking && b3.body.booking.existing} записів=${cnt3}`);
  const my = await api(U, 'GET', '/my');
  const up = (my.body && my.body.upcoming) || [];
  ok('«Мої записи» показують запис', up.some(a => ids.includes(Number(a.id))), 'id: ' + J(up.map(a => a.id)));
  ok('«Мої записи»: у записах нема телефонів і собівартості', !/cost|purchase|\+380/.test(J({ u: my.body.upcoming, h: my.body.history })));
  const cn = await api(U, 'POST', '/cancel', { ids });
  const st = (await q(`SELECT status FROM appointments WHERE id = ANY($1::int[])`, [ids])).map(x => x.status);
  ok('скасування з кабінету → у CRM cancelled', cn.status === 200 && st.length && st.every(s => s === 'cancelled'), cn.status + ' ' + st.join(','));
  const my2 = await api(U, 'GET', '/my');
  ok('після скасування запису нема в «попереду»', !((my2.body && my2.body.upcoming) || []).some(a => ids.includes(Number(a.id))));
  return { U, c, slot, body, ids };
}

// ── 2. Два клієнти на один слот одночасно → один отримує відмову ──
async function raceTwoClients(ms) {
  const A = mkUser('QA-FA Гонка А'), B = mkUser('QA-FA Гонка Б');
  await withPhone(A, rndPhone()); await withPhone(B, rndPhone());
  for (const u of [A, B]) { const c = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [u.id]))[0]; if (c) clientIds.push(c.id); }
  const slot = await pickSlot(ms.service_id, ms.master_id, 1);
  if (!slot) { ok('гонка: є слот', false); return; }
  const body = { service_id: ms.service_id, master_id: ms.master_id, date: slot.date, start_min: slot.start_min };
  const [ra, rb] = await Promise.all([api(A, 'POST', '/book', body), api(B, 'POST', '/book', body)]);
  const sts = [ra.status, rb.status].sort();
  const n = (await q(`SELECT count(*)::int n FROM appointments a JOIN clients c ON c.id=a.client_id WHERE c.telegram_id = ANY($1::bigint[])
      AND a.status IN ('booked','confirmed')`, [[A.id, B.id]]))[0].n;
  ok('два клієнти на один слот: один 200, другий 409 «час зайняли»', sts[0] === 200 && sts[1] === 409 && n === 1,
    `статуси ${ra.status}/${rb.status}, записів ${n}, відмова: ${J((ra.status === 409 ? ra : rb).body)}`);
  for (const r of [ra, rb]) if (r.body && r.body.booking) apptIds.push(...r.body.booking.ids);
}

// ── 3. rate-limit /book: 11-та спроба за хвилину → 429 ──
async function bookRate(ms) {
  const U = mkUser('QA-FA Ліміт'); await withPhone(U, rndPhone());
  const c = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [U.id]))[0]; if (c) clientIds.push(c.id);
  const st = [];
  for (let i = 0; i < 12; i++) st.push((await api(U, 'POST', '/book', { service_id: ms.service_id, master_id: ms.master_id, date: '2020-01-01', start_min: 600 + i })).status);
  ok('rate-limit /book: після 10 спроб за хвилину → 429', st.filter((s, i) => i < 10).every(s => s !== 429) && st[10] === 429, st.join(','));
}

// ── 4. Існуючий клієнт CRM за номером → історія ──
async function existingClient(ms) {
  const ph = rndPhone(); const U = mkUser('QA-FA Існуюча');
  const cid = (await q(`INSERT INTO clients (phone, name, source) VALUES ($1,'QA-FA Галина','qa-audit') RETURNING id`, [ph]))[0].id; clientIds.push(cid);
  const past = (await q(`INSERT INTO appointments (tenant_id, master_id, service_id, client_id, client_name, status, starts_at, ends_at, price, source)
      VALUES ($1,$2,$3,$4,'QA-FA','done', NOW()-interval '20 days', NOW()-interval '20 days'+interval '1 hour', 640, 'qa-audit') RETURNING id`,
    [TENANT, ms.master_id, ms.service_id, cid]))[0].id; apptIds.push(past);
  const man = await api(U, 'POST', '/contact', { phone: ph });
  ok('існуючий номер вручну → не привʼязує (need_verified)', man.status === 409 && man.body.error === 'need_verified', man.status + ' ' + J(man.body));
  await withPhone(U, ph);
  const link = (await q(`SELECT telegram_id FROM clients WHERE id=$1`, [cid]))[0];
  const dup = (await q(`SELECT count(*)::int n FROM clients WHERE telegram_id=$1`, [U.id]))[0].n;
  ok('підтверджений номер → привʼязано до НАЯВНОЇ картки (без дубля)', Number(link.telegram_id) === U.id && dup === 1, `tg=${link.telegram_id} карток=${dup}`);
  const my = await api(U, 'GET', '/my');
  ok('існуючий клієнт бачить історію візитів', ((my.body && my.body.history) || []).some(h => Number(h.id) === past), 'history id: ' + J(((my.body && my.body.history) || []).map(h => h.id)));
  const me = await api(U, 'GET', '/me');
  ok('існуючий клієнт: імʼя з CRM', me.body && me.body.client && /Галина/.test(me.body.client.name), J(me.body && me.body.client));
  return { U, cid, past };
}

// ── 5. Рахунок з товаром від адміна → сума = формула каси ──
async function billWithProduct(ex) {
  const today = (await q(`INSERT INTO appointments (tenant_id, master_id, service_id, client_id, client_name, status, starts_at, ends_at, price, source)
      SELECT $1, master_id, service_id, client_id, 'QA-FA', 'booked', date_trunc('hour', NOW()) - interval '30 minutes', date_trunc('hour', NOW())+interval '30 minutes', 750, 'qa-audit'
        FROM appointments WHERE id=$2 RETURNING id`, [TENANT, ex.past]))[0].id; apptIds.push(today);
  const pv = (await q(`SELECT pv.id, pv.price::float FROM product_variants pv JOIN products p ON p.id=pv.product_id
      WHERE pv.price>0 AND p.price_per_gram IS NULL ORDER BY pv.id LIMIT 1`))[0];
  const add = await admin('POST', `/api/consumables/appointment/${today}`, { variant_id: pv.id, qty_used: 2, billable: true });
  ok('адмін додав товар у візит', add.status === 200 || add.status === 201, add.status + ' ' + J(add.body));
  const expect = 750 + 2 * pv.price;
  const mb = await api(ex.U, 'GET', `/appointments/${today}/bill`);
  const ab = await admin('GET', `/api/schedule/appointments/${today}/bill`);
  const mFinal = mb.body && mb.body.bill && mb.body.bill.amount;
  const aFinal = ab.body && (ab.body.bill ? ab.body.bill.final : ab.body.final);
  ok('рахунок у застосунку = послуга + товар (формула каси)', Number(mFinal) === expect, `застосунок ${mFinal}, очікувано ${expect} (750 + 2×${pv.price})`);
  ok('рахунок у застосунку = рахунок адміна в CRM', Number(mFinal) === Number(aFinal), `застосунок ${mFinal}, CRM ${aFinal} (${ab.status})`);
  const pay = await api(ex.U, 'POST', `/appointments/${today}/pay`);
  note('оплата без MONO_TOKEN (QA)', `${pay.status} ${J(pay.body)} — реальний платіж не робився за умовою`);
  const pay2 = await api(ex.U, 'POST', `/appointments/${today}/pay`, { amount: 1 });
  ok('сума з клієнта ігнорується (amount у тілі нічого не міняє)', pay2.status === pay.status, `${pay2.status}`);
  const other = mkUser('QA-FA Чужий'); await withPhone(other, rndPhone());
  const oc = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [other.id]))[0]; if (oc) clientIds.push(oc.id);
  const ob = await api(other, 'GET', `/appointments/${today}/bill`);
  const op = await api(other, 'POST', `/appointments/${today}/pay`);
  const orate = await api(other, 'POST', `/appointments/${ex.past}/rate`, { stars: 1 });
  ok('чужий рахунок / оплата / оцінка → відмова', ob.status === 403 && op.status === 403 && orate.status >= 400 && orate.status !== 500, `${ob.status}/${op.status}/${orate.status}`);
}

// ── 6. Майстер за номером → кабінет; «Забрати доступ» / звільнення → клієнт, токен мертвий ──
async function masterFlow() {
  const ph = rndPhone();
  qaMasterId = (await q(`INSERT INTO masters (tenant_id, name, phone, active, online_booking_enabled) VALUES ($1,'QA-FA Майстер',$2,true,false) RETURNING id`, [TENANT, ph]))[0].id;
  const M = mkUser('QA-FA Майстер');
  await withPhone(M, ph);
  const c = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [M.id]))[0]; if (c) clientIds.push(c.id);
  const me = await api(M, 'GET', '/me');
  ok('майстер за підтвердженим номером → режим майстра', me.body && me.body.master && me.body.master.is_master === true, J(me.body && me.body.master));
  const s1 = await api(M, 'POST', '/master/session');
  const tok = s1.body && s1.body.token;
  ok('кабінет майстра: сесія видана', s1.status === 200 && !!tok, String(s1.status));
  const a1 = await admin('GET', '/api/me/profile', null, tok);
  ok('токен майстра відкриває кабінет (/api/me/profile) саме свого профілю', a1.status === 200 && a1.body.master && Number(a1.body.master.id) === Number(qaMasterId), a1.status + ' id=' + (a1.body && a1.body.master && a1.body.master.id));
  const own = await admin('GET', '/api/users', null, tok);
  ok('токен майстра НЕ відкриває список працівників', own.status === 401 || own.status === 403, String(own.status));
  const u = (await q(`SELECT id FROM users WHERE master_id=$1`, [qaMasterId]))[0];
  await q(`UPDATE users SET is_active=false WHERE id=$1`, [u.id]);
  const a2 = await admin('GET', '/api/me/profile', null, tok);
  const me2 = await api(M, 'GET', '/me');
  const s2 = await api(M, 'POST', '/master/session');
  ok('«Забрати доступ» → старий токен 401', a2.status === 401, String(a2.status));
  ok('«Забрати доступ» → у застосунку клієнтський режим, нова сесія 403', me2.body.master.is_master === false && s2.status === 403, J(me2.body.master) + ' ' + s2.status);
  await q(`UPDATE users SET is_active=true WHERE id=$1`, [u.id]);
  const s3 = await api(M, 'POST', '/master/session');
  const tok2 = s3.body && s3.body.token;
  await q(`UPDATE masters SET active=false, fire_date=CURRENT_DATE WHERE id=$1`, [qaMasterId]);
  const a3 = await admin('GET', '/api/me/profile', null, tok2);
  const me3 = await api(M, 'GET', '/me');
  ok('звільнений майстер → токен 401, застосунок у клієнтському режимі', s3.status === 200 && a3.status === 401 && me3.body.master.is_master === false, `${s3.status}/${a3.status}/${J(me3.body.master)}`);
}

// ── 7. Захоплення номера: чужий вводить номер руками раніше за власника ──
async function phoneSquat() {
  const ph = rndPhone(); const X = mkUser('QA-FA Нападник'); const O = mkUser('QA-FA Власник');
  const r1 = await api(X, 'POST', '/contact', { phone: ph });
  const xc = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [X.id]))[0]; if (xc) clientIds.push(xc.id);
  const r2 = await api(O, 'POST', '/contact', { contact: contactFor(O, ph) });
  const oc = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [O.id]))[0]; if (oc) clientIds.push(oc.id);
  ok('власник номера, підтвердивши його через Telegram, отримує картку, навіть якщо номер раніше ввів хтось чужий',
    r2.status === 200, `чужий ручний ввід: ${r1.status}; власник з підписаним контактом: ${r2.status} ${J(r2.body)}`);
}

// ── 8. Перебір номерів через /contact ──
async function contactEnum(ex) {
  const U = mkUser('QA-FA Перебір');
  const st = [];
  for (let i = 0; i < 25; i++) st.push((await api(U, 'POST', '/contact', { phone: rndPhone() })).status);
  const F = mkUser('QA-FA Оракул');
  const known = await api(F, 'POST', '/contact', { phone: (await q(`SELECT phone FROM clients WHERE id=$1`, [ex.cid]))[0].phone });
  const c = await q(`SELECT id FROM clients WHERE telegram_id=$1`, [U.id]); c.forEach(x => clientIds.push(x.id));
  ok('rate-limit /contact: 25 ручних номерів поспіль від одного TG обмежені', st.includes(429), st.join(','));
  ok('ручний ввід не розкриває, чи є номер у базі салону', !(known.status === 409 && /в базі/i.test(J(known.body))), `${known.status} ${J(known.body)}`);
}

// ── 9. Сповіщення майстру про нову бронь (QA без токена сповіщень: перевіряємо спробу у лозі) ──
async function masterNotify(ms, U) {
  const old = (await q(`SELECT telegram_id, notify_new_booking, notify_telegram FROM masters WHERE id=$1`, [ms.master_id]))[0];
  restoreMasterTg = { id: ms.master_id, ...old };
  await q(`UPDATE masters SET telegram_id=7799000999, notify_new_booking=true, notify_telegram=NULL WHERE id=$1`, [ms.master_id]);
  const slot = (await pickSlot(ms.service_id, ms.master_id, 2)) || (await pickSlot(ms.service_id, ms.master_id, 0));
  const re = /\[master-notify\] send/g;
  const before = countRe(S.log(), re);
  const b = await api(U, 'POST', '/book', { service_id: ms.service_id, master_id: ms.master_id, date: slot.date, start_min: slot.start_min });
  if (b.body && b.body.booking) apptIds.push(...b.body.booking.ids);
  await pause(8000);
  const after = countRe(S.log(), re);
  ok('нова бронь → спроба сповістити майстра (у QA: «[master-notify] send» без токена)', b.status === 200 && after > before, `бронь ${b.status}, спроб сповіщення ${after - before}`);
  await q(`UPDATE masters SET telegram_id=$2, notify_new_booking=$3, notify_telegram=$4 WHERE id=$1`, [ms.master_id, old.telegram_id, old.notify_new_booking, old.notify_telegram]);
  restoreMasterTg = null;
}

async function cleanup() {
  if (restoreMasterTg) await q(`UPDATE masters SET telegram_id=$2, notify_new_booking=$3, notify_telegram=$4 WHERE id=$1`,
    [restoreMasterTg.id, restoreMasterTg.telegram_id, restoreMasterTg.notify_new_booking, restoreMasterTg.notify_telegram]).catch(() => {});
  const cl = await q(`SELECT id FROM clients WHERE telegram_id = ANY($1::bigint[]) OR id = ANY($2::int[])`, [uids, clientIds]);
  const ids = cl.map(r => r.id);
  const aps = [...new Set([...apptIds, ...(ids.length ? (await q(`SELECT id FROM appointments WHERE client_id = ANY($1::int[])`, [ids])).map(r => r.id) : [])])];
  if (aps.length) {
    for (const t of ['appointment_materials', 'booking_reminders', 'notification_log', 'mono_invoices', 'visit_ratings']) await q(`DELETE FROM ${t} WHERE appointment_id = ANY($1::int[])`, [aps]).catch(() => {});
    await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [aps]).catch(e => console.error('cleanup appts:', e.message));
  }
  if (ids.length) {
    await q(`DELETE FROM online_bookings WHERE client_id = ANY($1::int[])`, [ids]).catch(() => {});
    await q(`DELETE FROM clients WHERE id = ANY($1::int[])`, [ids]).catch(e => console.error('cleanup clients:', e.message));
  }
  if (qaMasterId) {
    const us = (await q(`SELECT id FROM users WHERE master_id=$1`, [qaMasterId])).map(r => r.id);
    if (us.length) { await q(`DELETE FROM user_tokens WHERE user_id = ANY($1::int[])`, [us]).catch(() => {}); await q(`DELETE FROM users WHERE id = ANY($1::int[])`, [us]).catch(e => console.error('cleanup users:', e.message)); }
    await q(`DELETE FROM masters WHERE id=$1`, [qaMasterId]).catch(e => console.error('cleanup master:', e.message));
  }
  if (seededSched.length) await q(`DELETE FROM master_schedule_days WHERE id = ANY($1::int[]) AND source='qa-audit'`, [seededSched]).catch(e => console.error('cleanup sched:', e.message));
  const left = (await q(`SELECT count(*)::int n FROM clients WHERE telegram_id = ANY($1::bigint[])`, [uids]))[0].n;
  const leftA = (await q(`SELECT count(*)::int n FROM appointments WHERE id = ANY($1::int[])`, [aps]))[0].n;
  console.log(`прибрано QA: клієнтів ${ids.length}, візитів ${aps.length}, майстер ${qaMasterId || '-'}; залишилось: клієнтів ${left}, візитів ${leftA}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!process.env.QA_DB_URL || process.env.QA_DB_URL === process.env.DATABASE_URL) throw new Error('QA_DB_URL порожній або = DATABASE_URL — стоп');
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  PROBE = mkUser('QA-FA Пробник');
  let fatal = null;
  try {
    const ms = (await q(`SELECT ms.master_id, ms.service_id FROM master_services ms JOIN masters m ON m.id=ms.master_id
       JOIN services s ON s.id=ms.service_id WHERE m.active AND m.online_booking_enabled IS NOT FALSE AND ms.active IS NOT FALSE AND s.active IS NOT FALSE
       AND COALESCE(s.price,0) > 0 ORDER BY ms.master_id, ms.service_id LIMIT 1`))[0];
    console.log('майстер/послуга QA:', J(ms));
    // QA-копія без майбутнього графіка → додаємо 3 робочі дні 10:00–19:00 (лише ті, яких нема), прибираємо в cleanup
    seededSched = (await q(`INSERT INTO master_schedule_days (tenant_id, master_id, work_date, start_time, end_time, source)
        SELECT $1, $2, (CURRENT_DATE + g)::date, '10:00', '19:00', 'qa-audit' FROM generate_series(1,3) g
        ON CONFLICT (master_id, work_date) DO NOTHING RETURNING id`, [TENANT, ms.master_id])).map(r => r.id);
    console.log('додано QA-днів графіка:', seededSched.length);
    const step = async (n, f) => { try { return await f(); } catch (e) { ok(n + ' без збоїв', false, String(e && e.message || e)); } };
    const nc = await step('новий клієнт', () => newClientBooking(ms));
    await step('гонка', () => raceTwoClients(ms));
    await step('rate-limit', () => bookRate(ms));
    const ex = await step('існуючий клієнт', () => existingClient(ms));
    if (ex) await step('рахунок', () => billWithProduct(ex));
    await step('майстер', masterFlow);
    await step('захоплення номера', phoneSquat);
    if (ex) await step('перебір номерів', () => contactEnum(ex));
    if (nc) await step('сповіщення майстру', () => masterNotify(ms, nc.U));
    await step('files id', async () => {
      const r = [await admin('GET', '/api/files/upload'), await admin('GET', '/api/files/not-a-uuid/meta'), await fetch(BASE + '/api/files/xyz').then(x => ({ status: x.status }))];
      ok('files: не-UUID в адресі → 404, а не 500', r.every(x => x.status === 404), r.map(x => x.status).join('/'));
    });
  } catch (e) { fatal = e; console.error(e); }
  finally {
    await cleanup().catch(e => console.error('cleanup:', e.message));
    fs.writeFileSync(path.join(OUT, 'qa-server-e2e.log'), S.log());
    S.stop(); await db.end().catch(() => {});
  }
  const fail = results.filter(r => r.pass === false);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), J(results));
  console.log(`\nПІДСУМОК e2e: ${results.filter(r => r.pass).length}/${results.filter(r => r.pass !== null).length} ✔` + (fail.length ? `, ✘ ${fail.length}` : ''));
  process.exit(fatal || fail.length ? 1 : 0);
})();
