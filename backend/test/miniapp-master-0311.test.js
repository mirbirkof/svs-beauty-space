// Mini App, частина 2 (Босс 03.11): звʼязка «Telegram ↔ майстер», заявка «Я майстер», кабінет майстра, сповіщення.
// БЕЗПЕКА: окремий сервер :3061 поверх QA_DB_URL (пісочниця). Прод не чіпається.
// Перевіряє:
//  • ручний номер майстра (набраний руками) → прав майстра НЕМАЄ (/master/session 403);
//  • підписаний контакт з номером майстра → автоупізнавання, сесія ролі «Майстер»;
//  • права: свої /api/me/stats|today, /api/payouts/my → 200; хазяйське /api/payouts/sheet, /api/payouts/rules → 403;
//    «не прийшов» на чужий запис → 403, на свій сьогоднішній → 200 + undo;
//  • заявка «Я майстер»: кандидати, дубль → 409, не-власник ✔ → відмова, власник ✔ → учётка + telegram_id,
//    masters.phone лише якщо був порожній; після ✔ — сесія видається;
//  • lib/master-notify: нова запис / перенос / скасування → повідомлення в Telegram майстра.
// Фікстури: TG id 78xxxxxxxx, записи client_name 'QA-P2-0311'; усе повертається/видаляється в after.
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
  assert.ok(!r.body || !r.body.master, 'ручний номер не розпізнається як майстер');
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
  assert.ok(r.body.master && r.body.master.linked, 'упізнано: ' + JSON.stringify(r.body.master));
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

test('заявка «Я майстер»: кандидат → ✔ власника → обліковка «Майстер» і сесія', { skip }, async () => {
  assert.ok(CAND, 'у QA є працюючий майстер без обліковки');
  const u = mkUser('claim'); const init = initFor(u);
  const ph = '+38097' + String(Math.floor(1e6 + Math.random() * 8.9e6));
  const cands = await call(init, 'GET', '/master/candidates');
  assert.ok(cands.body.masters.some(m => m.id === CAND.id), 'кандидат у списку');
  assert.ok(!cands.body.masters.some(m => m.id === M.master_id), 'майстер з привʼязаним TG у список не потрапляє');
  // без підписаного контакту заявки немає
  assert.strictEqual((await call(init, 'POST', '/master/claim', { master_id: CAND.id })).status, 400);
  assert.strictEqual((await call(init, 'POST', '/master/claim', { contact: contactFor(mkUser('x'), ph), master_id: CAND.id })).status, 400, 'чужий контакт');
  const cl = await call(init, 'POST', '/master/claim', { contact: contactFor(u, ph), master_id: CAND.id });
  assert.strictEqual(cl.status, 200, JSON.stringify(cl.body));
  assert.strictEqual((await call(init, 'POST', '/master/claim', { contact: contactFor(u, ph), master_id: CAND.id })).status, 409, 'дубль');
  assert.strictEqual((await call(init, 'POST', '/master/session', {})).status, 403, 'без ✔ прав немає');
  const claim = (await q(`SELECT * FROM master_claims WHERE tg_user_id=$1 AND status='pending'`, [u.id]))[0];
  assert.ok(claim); assert.strictEqual(claim.phone, '380' + ph.slice(-9));
  const me = await call(init, 'GET', '/me');
  assert.strictEqual(me.body.master.claim.status, 'pending');

  const ml = require('../lib/master-link');
  const calls = []; const tg = async (m, p) => { calls.push({ m, p }); return { ok: true }; };
  // не власник натиснув ✔ → відмова, нічого не записано
  await ml.onClaimCallback({ id: 'q1', data: 'mc:ok:' + claim.id, from: { id: u.id } }, { pool, tg, tenantId: TID });
  assert.ok(calls.some(c => c.m === 'answerCallbackQuery' && /власник/.test(c.p.text)));
  assert.strictEqual((await q(`SELECT status FROM master_claims WHERE id=$1`, [claim.id]))[0].status, 'pending');
  // власник ✔
  calls.length = 0;
  await ml.onClaimCallback({ id: 'q2', data: 'mc:ok:' + claim.id, from: { id: OWNER_TG }, message: { chat: { id: OWNER_TG }, message_id: 1, text: 'запит' } }, { pool, tg, tenantId: TID });
  assert.strictEqual((await q(`SELECT status FROM master_claims WHERE id=$1`, [claim.id]))[0].status, 'approved');
  const mm = (await q(`SELECT phone, telegram_id FROM masters WHERE id=$1`, [CAND.id]))[0];
  assert.strictEqual(Number(mm.telegram_id), u.id); assert.strictEqual(mm.phone, claim.phone, 'masters.phone був порожній → заповнено');
  const nu = (await q(`SELECT u.phone, r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.telegram_id=$1 AND u.master_id=$2`, [u.id, CAND.id]))[0];
  assert.ok(nu && nu.code === 'master', 'обліковка «Майстер» створена');
  assert.ok(calls.some(c => c.m === 'sendMessage' && Number(c.p.chat_id) === u.id), 'заявнику прийшла відповідь');
  // повторне ✔ — «вже вирішено», без змін
  calls.length = 0;
  await ml.onClaimCallback({ id: 'q3', data: 'mc:ok:' + claim.id, from: { id: OWNER_TG } }, { pool, tg, tenantId: TID });
  assert.ok(calls.some(c => /вирішено/.test(c.p.text || '')));
  const s = await call(init, 'POST', '/master/session', {});
  assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  assert.strictEqual(s.body.master.id, CAND.id);
  assert.strictEqual((await crm(s.body.token, 'GET', '/api/me/stats')).status, 200);
});
