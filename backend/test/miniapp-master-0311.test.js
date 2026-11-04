// Mini App: звʼязка «Telegram ↔ майстер», кабінет майстра, сповіщення (Босс 03.11) + авто-майстер без кнопки (Босс 04.11).
// БЕЗПЕКА: окремий сервер :3061 поверх QA_DB_URL (пісочниця). Прод не чіпається.
// Перевіряє:
//  • ручний номер майстра (набраний руками) → прав майстра НЕМАЄ (/master/session 403), обліковка не створюється;
//  • підписаний контакт з номером майстра → автоупізнавання, сесія ролі «Майстер»;
//  • права: свої /api/me/stats|today, /api/payouts/my → 200; хазяйське /api/payouts/sheet, /api/payouts/rules → 403;
//    «не прийшов» на чужий запис → 403, на свій сьогоднішній → 200 + undo;
//  • lib/master-notify: нова запис / перенос / скасування → повідомлення в Telegram майстра;
//  • 04.11: майстер БЕЗ обліковки → обліковка «Майстер» створюється сама; номер внесли в CRM пізніше → /me сам вмикає
//    режим; звільнення → клієнт + токен мертвий; повернення → знову майстер; номер у двох майстрів → клієнт + audit;
//    кнопки «Я майстер» більше немає (/master/claim, /master/candidates не 200), старі ✔ заявок працюють.
// Фікстури: TG id 78xxxxxxxx, записи 'QA-P2-0311', майстри 'QA-AUTO-0411 …'; усе повертається/видаляється в after.
require('dotenv').config();
const QA_URL = process.env.QA_DB_URL;
// модулі lib у процесі тесту ходять ЛИШЕ в QA (ніколи не в прод)
if (QA_URL) { process.env.DATABASE_URL = QA_URL; process.env.DATABASE_URL_APP = QA_URL; }
const OWNER_TG_ENV = '7899000001'; process.env.ADMIN_TG_CHAT = OWNER_TG_ENV; // «власник» і в процесі тесту (approvers)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = Number(process.env.MINIAPP_MASTER_TEST_PORT || 3061);
const BASE = `http://127.0.0.1:${PORT}`;
const TID = '00000000-0000-0000-0000-000000000001';
const BOT = '7000000002:QA-' + crypto.randomBytes(10).toString('hex');
const OWNER_TG = 7899000001;          // ADMIN_TG_CHAT у тест-процесі = «власник»
const now = () => Math.floor(Date.now() / 1000);
const uids = [];
const mkUser = (n) => { const id = 7800000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: 'QA P2 ' + n, username: 'qa_p2_' + id }; };
const initFor = (u) => sign({ auth_date: now(), query_id: 'AAp' + u.id, user: u }, BOT);
const contactFor = (u, phone, token = BOT) => sign({ contact: { user_id: u.id, phone_number: phone, first_name: u.first_name }, auth_date: now() }, token);

let pool, S, M = null, CAND = null;
const qaMasters = []; // майстри-фікстури 04.11 (прибираються в after)
const rndPhone = () => '38097' + String(Math.floor(1e6 + Math.random() * 8.9e6));
async function mkMaster(name, phone) {
  const r = await q(`INSERT INTO masters (tenant_id, name, phone, active, in_schedule) VALUES ($1,$2,$3,true,true) RETURNING id, name`,
    [TID, 'QA-AUTO-0411 ' + name, phone || null]);
  qaMasters.push(r[0].id); return r[0];
}
const q = async (sql, p) => (await pool.query(sql, p)).rows;
async function call(init, method, url, body) {
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function crm(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
const saved = { users: [], masters: [] };
const apptIds = [];

before(async () => {
  if (!QA_URL) return;
  pool = new Pool({ connectionString: QA_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  // майстер з обліковкою «Майстер» і телефоном, без Telegram
  M = (await q(`SELECT u.id AS uid, u.phone, u.master_id, m.name FROM users u JOIN roles r ON r.id=u.role_id JOIN masters m ON m.id=u.master_id
                 WHERE r.code='master' AND u.is_active AND u.merged_into IS NULL AND u.telegram_id IS NULL AND m.telegram_id IS NULL
                   AND m.active AND length(regexp_replace(COALESCE(u.phone,''),'\\D','','g'))>=9 ORDER BY u.id LIMIT 1`))[0];
  // кандидат для заявки: працюючий майстер без обліковки і без телефону
  CAND = (await q(`SELECT m.id, m.name FROM masters m WHERE m.active AND COALESCE(m.staff_role,'master')='master' AND COALESCE(m.provides_services,true)
                    AND COALESCE(m.phone,'')='' AND m.telegram_id IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.master_id=m.id) ORDER BY m.id LIMIT 1`))[0];
  if (M) { saved.users.push((await q(`SELECT id, telegram_id, phone FROM users WHERE id=$1`, [M.uid]))[0]);
    saved.masters.push((await q(`SELECT id, telegram_id, phone FROM masters WHERE id=$1`, [M.master_id]))[0]); }
  if (CAND) saved.masters.push((await q(`SELECT id, telegram_id, phone FROM masters WHERE id=$1`, [CAND.id]))[0]);
  // записи майстра M: сьогодні щойно минула (для «не прийшов») і завтра (для сповіщень)
  if (M) {
    const a1 = await q(`INSERT INTO appointments (tenant_id, master_id, client_name, status, starts_at, ends_at, price)
      VALUES ($1,$2,'QA-P2-0311','booked', GREATEST(date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv', now()-interval '5 minutes'),
              now()+interval '40 minutes', 500) RETURNING id`, [TID, M.master_id]);
    const a2 = await q(`INSERT INTO appointments (tenant_id, master_id, client_name, status, starts_at, ends_at, price)
      VALUES ($1,$2,'QA-P2-0311','booked', now()+interval '1 day', now()+interval '1 day 1 hour', 700) RETURNING id`, [TID, M.master_id]);
    const other = await q(`INSERT INTO appointments (tenant_id, master_id, client_name, status, starts_at, ends_at, price)
      SELECT $1, m.id, 'QA-P2-0311', 'booked', now()-interval '5 minutes', now()+interval '40 minutes', 500 FROM masters m WHERE m.id<>$2 AND m.active ORDER BY m.id LIMIT 1 RETURNING id`, [TID, M.master_id]);
    apptIds.push(a1[0].id, a2[0].id, other[0].id);
  }
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: String(OWNER_TG), BOT_TEXT_BOOKING: '' } });
}, { timeout: 180000 });

after(async () => {
  if (S) { const errs = S.log().split('\n').filter(l => /\[miniapp|master-link|me\/|Error/.test(l)); if (errs.length) console.error('server log:\n' + errs.slice(-20).join('\n')); S.stop(); }
  if (!pool) return;
  const c = async (sql, p) => pool.query(sql, p).catch(e => console.error('cleanup:', e.message));
  if (apptIds.length) {
    await c(`DELETE FROM audit_log WHERE entity='appointment' AND entity_id = ANY($1::int[])`, [apptIds]);
    await c(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [apptIds]);
  }
  // обліковки, створені ✔ заявки (лише ті, що мають наші TG id)
  const created = (await pool.query(`SELECT id FROM users WHERE telegram_id = ANY($1::bigint[]) AND NOT (id = ANY($2::int[]))`, [uids, saved.users.map(u => u.id)]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
  const allU = created.concat(saved.users.map(u => u.id));
  if (allU.length) await c(`DELETE FROM user_tokens WHERE user_id = ANY($1::int[])`, [allU]);
  if (created.length) await c(`DELETE FROM users WHERE id = ANY($1::int[])`, [created]);
  for (const u of saved.users) await c(`UPDATE users SET telegram_id=$2, phone=$3 WHERE id=$1`, [u.id, u.telegram_id, u.phone]);
  for (const m of saved.masters) await c(`UPDATE masters SET telegram_id=$2, phone=$3 WHERE id=$1`, [m.id, m.telegram_id, m.phone]);
  if (uids.length) {
    await c(`DELETE FROM master_claims WHERE tg_user_id = ANY($1::bigint[])`, [uids]);
    await c(`DELETE FROM clients WHERE telegram_id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id=clients.id)`, [uids]);
  }
  if (qaMasters.length) {
    const fu = (await pool.query(`SELECT id FROM users WHERE master_id = ANY($1::int[])`, [qaMasters]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    if (fu.length) {
      await c(`DELETE FROM user_tokens WHERE user_id = ANY($1::int[])`, [fu]);
      await c(`DELETE FROM user_sessions WHERE user_id = ANY($1::int[])`, [fu]);
      await c(`DELETE FROM users WHERE id = ANY($1::int[])`, [fu]);
    }
    await c(`DELETE FROM master_claims WHERE master_id = ANY($1::int[])`, [qaMasters]);
    await c(`DELETE FROM audit_log WHERE entity='master' AND entity_id = ANY($1::int[])`, [qaMasters]);
    await c(`DELETE FROM masters WHERE id = ANY($1::int[])`, [qaMasters]);
  }
  if (uids.length) await c(`DELETE FROM audit_log WHERE action='master.auto_conflict' AND (meta->>'tg')::bigint = ANY($1::bigint[])`, [uids]);
  await pool.end();
});

const skip = !QA_URL && 'QA_DB_URL не задан';

test('новий підписник: /me без телефону і не майстер', { skip }, async () => {
  const u = mkUser('new'); const r = await call(initFor(u), 'GET', '/me');
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.client || !r.body.client.has_phone, 'телефону ще немає → мініап попросить');
  assert.strictEqual(r.body.master.is_master, false);
});

test('номер майстра, введений вручну → прав майстра НЕМАЄ', { skip }, async () => {
  assert.ok(M, 'у QA є майстер з обліковкою і телефоном');
  const u = mkUser('manual'); const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { phone: '+' + String(M.phone).replace(/\D/g, ''), name: 'QA Самозванець' });
  assert.ok([200, 409].includes(r.status), JSON.stringify(r.body));
  assert.ok(!r.body || !r.body.master || !r.body.master.is_master, 'ручний номер не розпізнається як майстер');
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 403);
  assert.strictEqual((await q(`SELECT telegram_id FROM users WHERE id=$1`, [M.uid]))[0].telegram_id, null, 'TG не привʼязано');
  // підписаний контакт, але ЧУЖИЙ user_id → теж ні
  const foreign = sign({ contact: { user_id: u.id + 1, phone_number: M.phone }, auth_date: now() }, BOT);
  assert.strictEqual((await call(init, 'POST', '/contact', { contact: foreign })).status, 400);
  const forged = contactFor(u, M.phone, 'інший-токен');
  assert.strictEqual((await call(init, 'POST', '/contact', { contact: forged })).status, 401);
});

let MT = null, MU = null;
test('номер майстра з контакту Telegram → режим майстра, свої дані 200, чужі/хазяйські 403', { skip }, async () => {
  MU = mkUser('master'); const init = initFor(MU);
  const r = await call(init, 'POST', '/contact', { contact: contactFor(MU, '+' + String(M.phone).replace(/\D/g, '')) });
  // 409 — клієнтську картку з цим номером уже зайняв «самозванець» ручним вводом (тест 2); режим майстра від цього не залежить
  assert.ok([200, 409].includes(r.status), JSON.stringify(r.body));
  assert.ok(r.body.master && r.body.master.is_master, 'упізнано: ' + JSON.stringify(r.body.master));
  assert.strictEqual(Number((await q(`SELECT telegram_id FROM users WHERE id=$1`, [M.uid]))[0].telegram_id), MU.id);
  const me = await call(init, 'GET', '/me');
  assert.strictEqual(me.body.master.is_master, true);
  const s = await call(init, 'POST', '/master/session', {});
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  assert.strictEqual(s.body.master.id, M.master_id);
  MT = s.body.token;
  const st = await crm(MT, 'GET', '/api/me/stats');
  assert.strictEqual(st.status, 200, JSON.stringify(st.body));
  for (const k of ['upcoming', 'money', 'visits', 'new_clients', 'repeat_clients', 'avg_check', 'load', 'cancelled', 'noshow', 'reviews']) assert.ok(k in st.body, 'stats.' + k);
  assert.ok(st.body.upcoming.tomorrow >= 1 || st.body.upcoming.week >= 1, 'завтрашній запис видно');
  const td = await crm(MT, 'GET', '/api/me/today');
  assert.strictEqual(td.status, 200);
  assert.ok(td.body.items.some(a => a.id === apptIds[0]), 'сьогоднішній свій запис у списку');
  assert.ok(!td.body.items.some(a => a.id === apptIds[2]), 'чужого запису немає');
  assert.strictEqual((await crm(MT, 'GET', '/api/payouts/my')).status, 200, 'своя зарплата');
  assert.strictEqual((await crm(MT, 'GET', '/api/payouts/sheet')).status, 403, 'відомість салону — хазяйське');
  assert.strictEqual((await crm(MT, 'GET', '/api/payouts/rules')).status, 403, 'правила ЗП — хазяйське');
  assert.strictEqual((await crm(MT, 'POST', `/api/me/appointments/${apptIds[2]}/noshow`, {})).status, 403, 'чужий запис');
  assert.strictEqual((await crm(MT, 'POST', `/api/me/appointments/${apptIds[1]}/noshow`, {})).status, 403, 'майбутній запис');
  const ns = await crm(MT, 'POST', `/api/me/appointments/${apptIds[0]}/noshow`, {});
  assert.strictEqual(ns.status, 200, JSON.stringify(ns.body));
  assert.strictEqual((await q(`SELECT status FROM appointments WHERE id=$1`, [apptIds[0]]))[0].status, 'noshow');
  const un = await crm(MT, 'POST', `/api/me/appointments/${apptIds[0]}/noshow`, { undo: true });
  assert.strictEqual(un.status, 200);
  assert.strictEqual((await q(`SELECT status FROM appointments WHERE id=$1`, [apptIds[0]]))[0].status, 'booked');
  // інший Telegram не отримає сесію цього майстра
  assert.strictEqual((await call(initFor(mkUser('other')), 'POST', '/master/session', {})).status, 403);
  assert.strictEqual((await crm('bogus-' + MT, 'GET', '/api/me/stats')).status, 401);
});

test('сповіщення майстру: нова / перенос / скасування (master-notify)', { skip }, async () => {
  assert.ok(MU, 'майстер привʼязаний попереднім тестом');
  const notify = require('../lib/master-notify');
  const sent = []; notify._setSender(async (chat, text) => { sent.push({ chat, text }); }); notify._reset();
  await notify.handle('created', { payload: { appointment_id: apptIds[1] } }, pool);
  await notify.handle('rescheduled', { payload: { appointment_id: apptIds[1], old_starts_at: new Date(Date.now() + 2 * 864e5).toISOString() } }, pool);
  await notify.handle('cancelled', { payload: { appointment_ids: [apptIds[1]] } }, pool);
  await notify.handle('created', { payload: { appointment_id: apptIds[1] } }, pool); // дубль у межах 10 хв → не шлемо
  assert.strictEqual(sent.length, 3, JSON.stringify(sent));
  assert.ok(sent.every(s => s.chat === String(MU.id)));
  assert.match(sent[0].text, /Новий запис/); assert.match(sent[1].text, /перенесено/); assert.match(sent[2].text, /скасовано/);
  assert.ok(!sent.some(s => /\+?380\d{9}/.test(s.text)), 'телефон клієнта не шлемо');
});

// ─── 04.11: майстер визначається сам, без кнопки «Я майстер салону» ───
const muser = async (masterId) => (await q(`SELECT u.id, u.telegram_id, u.phone, u.is_active, r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.master_id=$1`, [masterId]));

let A = null, AU = null, AT = null;
test('авто-майстер БЕЗ обліковки: підписаний контакт → обліковка «Майстер» створюється сама, сесія 200', { skip }, async () => {
  const ph = rndPhone();
  A = await mkMaster('A', ph);
  AU = mkUser('auto'); const init = initFor(AU);
  const r = await call(init, 'POST', '/contact', { contact: contactFor(AU, '+' + ph) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.master && r.body.master.is_master, 'упізнано без жодної кнопки: ' + JSON.stringify(r.body.master));
  const us = await muser(A.id);
  assert.strictEqual(us.length, 1, 'рівно одна обліковка');
  assert.strictEqual(us[0].code, 'master'); assert.strictEqual(Number(us[0].telegram_id), AU.id); assert.strictEqual(us[0].phone, '380' + ph.slice(-9));
  const cl = (await q(`SELECT tg_verified_phone FROM clients WHERE telegram_id=$1 AND deleted_at IS NULL`, [AU.id]))[0];
  assert.ok(cl && cl.tg_verified_phone === '380' + ph.slice(-9), 'підтверджений номер збережено');
  const s = await call(init, 'POST', '/master/session', {});
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  assert.strictEqual(s.body.master.id, A.id);
  AT = s.body.token;
  assert.strictEqual((await crm(AT, 'GET', '/api/me/stats')).status, 200);
  assert.ok((await q(`SELECT 1 FROM audit_log WHERE action='master.account_auto_create' AND entity_id=$1`, [A.id])).length, 'audit');
});

test('звільнення → режим клієнта, кабінет лишається, старий токен майстра одразу не діє', { skip }, async () => {
  assert.ok(AT, 'попередній тест видав токен');
  const { setWorkingState } = require('../lib/employment');
  await setWorkingState(pool, A.id, false, { fired: true });
  assert.strictEqual((await crm(AT, 'GET', '/api/me/stats')).status, 401, 'токен звільненого майстра мертвий');
  const init = initFor(AU);
  const me = await call(init, 'GET', '/me');
  assert.strictEqual(me.status, 200, 'кабінет лишається');
  assert.strictEqual(me.body.master.is_master, false, 'тепер клієнт');
  assert.ok(me.body.client && me.body.client.has_phone, 'клієнтська картка з номером на місці');
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 403);
  assert.strictEqual((await muser(A.id)).length, 1, 'обліковку не видалено');
});

test('повернення на роботу → режим майстра вмикається сам', { skip }, async () => {
  const { setWorkingState } = require('../lib/employment');
  await setWorkingState(pool, A.id, true);
  const init = initFor(AU);
  const me = await call(init, 'GET', '/me');
  assert.strictEqual(me.body.master.is_master, true, JSON.stringify(me.body.master));
  const s = await call(init, 'POST', '/master/session', {});
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  AT = s.body.token;
  assert.strictEqual((await crm(AT, 'GET', '/api/me/stats')).status, 200);
  // захист в rbac: картку вимкнули напряму (повз setWorkingState, users.is_active лишився true) → токен однаково мертвий
  await q(`UPDATE masters SET active=false WHERE id=$1`, [A.id]);
  try {
    assert.strictEqual((await crm(AT, 'GET', '/api/me/stats')).status, 401, 'токен miniapp-master неактивної картки');
  } finally { await q(`UPDATE masters SET active=true WHERE id=$1`, [A.id]); }
  assert.strictEqual((await crm(AT, 'GET', '/api/me/stats')).status, 200);
});

test('номер внесли в CRM ПІЗНІШЕ → /me сам вмикає режим майстра без нового запиту номера', { skip }, async () => {
  const ph = rndPhone();
  const B = await mkMaster('B', null);
  const u = mkUser('later'); const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { contact: contactFor(u, '+' + ph) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.master.is_master, 'поки номера в CRM немає — клієнт');
  assert.strictEqual((await q(`SELECT tg_verified_phone FROM clients WHERE telegram_id=$1`, [u.id]))[0].tg_verified_phone, '380' + ph.slice(-9));
  await q(`UPDATE masters SET phone=$2 WHERE id=$1`, [B.id, '0' + ph.slice(-9)]); // інший формат запису — збіг по 9 цифрах
  const me = await call(init, 'GET', '/me');
  assert.strictEqual(me.body.master.is_master, true, JSON.stringify(me.body.master));
  const us = await muser(B.id);
  assert.ok(us.length === 1 && us[0].code === 'master' && Number(us[0].telegram_id) === u.id);
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 200);
});

test('ручний номер майстра без обліковки → обліковка НЕ створюється, прав немає', { skip }, async () => {
  const ph = rndPhone();
  const E = await mkMaster('E', ph);
  const u = mkUser('manualE'); const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { phone: '+' + ph, name: 'QA Ручний' });
  assert.ok([200, 409].includes(r.status), JSON.stringify(r.body));
  assert.ok(!r.body.master || !r.body.master.is_master);
  assert.strictEqual((await call(init, 'GET', '/me')).body.master.is_master, false);
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 403);
  assert.strictEqual((await muser(E.id)).length, 0, 'обліковки немає');
  const cl = (await q(`SELECT tg_verified_phone FROM clients WHERE telegram_id=$1`, [u.id]))[0];
  assert.ok(!cl || !cl.tg_verified_phone, 'ручний номер не позначається підтвердженим');
});

test('номер у ДВОХ майстрів → клієнт, нічого не привʼязано, audit конфлікту', { skip }, async () => {
  const ph = rndPhone();
  const F1 = await mkMaster('F1', ph), F2 = await mkMaster('F2', '0' + ph.slice(-9));
  const u = mkUser('twin'); const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { contact: contactFor(u, '+' + ph) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.master.is_master, false);
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 403);
  assert.strictEqual((await muser(F1.id)).length + (await muser(F2.id)).length, 0);
  const ms = await q(`SELECT telegram_id FROM masters WHERE id = ANY($1::int[])`, [[F1.id, F2.id]]);
  assert.ok(ms.every(m => m.telegram_id == null), 'TG не привʼязано');
  const au = await q(`SELECT meta FROM audit_log WHERE action='master.auto_conflict' AND (meta->>'tg')::bigint=$1`, [u.id]);
  assert.ok(au.length >= 1 && au[0].meta.reason === 'phone_many_masters', JSON.stringify(au));
});

test('кнопки «Я майстер» більше немає; стара заявка + ✔ власника досі працює', { skip }, async () => {
  const u = mkUser('claim'); const init = initFor(u);
  assert.notStrictEqual((await call(init, 'GET', '/master/candidates')).status, 200);
  assert.notStrictEqual((await call(init, 'POST', '/master/claim', { master_id: 1 })).status, 200);
  assert.ok(CAND, 'у QA є працюючий майстер без обліковки');
  const ph = '380' + rndPhone().slice(-9);
  const claim = (await q(`INSERT INTO master_claims (tenant_id, tg_user_id, tg_name, phone, master_id) VALUES ($1,$2,'QA claim',$3,$4) RETURNING *`,
    [TID, u.id, ph, CAND.id]))[0];
  const ml = require('../lib/master-link');
  const calls = []; const tg = async (m, p) => { calls.push({ m, p }); return { ok: true }; };
  await ml.onClaimCallback({ id: 'q1', data: 'mc:ok:' + claim.id, from: { id: u.id } }, { pool, tg, tenantId: TID });
  assert.ok(calls.some(c => c.m === 'answerCallbackQuery' && /власник/.test(c.p.text)), 'не власник — відмова');
  assert.strictEqual((await q(`SELECT status FROM master_claims WHERE id=$1`, [claim.id]))[0].status, 'pending');
  calls.length = 0;
  await ml.onClaimCallback({ id: 'q2', data: 'mc:ok:' + claim.id, from: { id: OWNER_TG }, message: { chat: { id: OWNER_TG }, message_id: 1, text: 'запит' } }, { pool, tg, tenantId: TID });
  assert.strictEqual((await q(`SELECT status FROM master_claims WHERE id=$1`, [claim.id]))[0].status, 'approved');
  const mm = (await q(`SELECT phone, telegram_id FROM masters WHERE id=$1`, [CAND.id]))[0];
  assert.strictEqual(Number(mm.telegram_id), u.id); assert.strictEqual(mm.phone, ph, 'masters.phone був порожній → заповнено');
  const nu = (await q(`SELECT r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.telegram_id=$1 AND u.master_id=$2`, [u.id, CAND.id]))[0];
  assert.ok(nu && nu.code === 'master', 'обліковка «Майстер» створена');
  calls.length = 0;
  await ml.onClaimCallback({ id: 'q3', data: 'mc:ok:' + claim.id, from: { id: OWNER_TG } }, { pool, tg, tenantId: TID });
  assert.ok(calls.some(c => /вирішено/.test(c.p.text || '')));
  const s = await call(init, 'POST', '/master/session', {});
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  assert.strictEqual(s.body.master.id, CAND.id);
});
