// Браузерна приймання Mini App, частина 2 (Босс 03.11): Chromium 390×844, підписаний initData, ЛИШЕ QA-база.
// Запуск: node test/_miniapp-master-e2e-0311.js  (не входить у щит: префікс «_»).
// 4 сценарії: клієнт без телефону → просимо номер; чужий номер вручну → прав майстра нема;
// номер майстра з контакту Telegram → режим майстра зі статистикою; чуже → 403. + екран «Я майстер салону».
// Скріншоти → ../reports/miniapp-0311-p2/. Усе створене прибирається, майстер повертається як був.
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = 3062;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'miniapp-0311-p2');
const BOT = '7000000003:QA-' + crypto.randomBytes(10).toString('hex');
const TID = '00000000-0000-0000-0000-000000000001';
const now = () => Math.floor(Date.now() / 1000);
const uids = [];
const mkUser = (n) => { const id = 7800000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_p2e_' + id }; };
const initFor = (u) => sign({ auth_date: now(), query_id: 'AAm' + u.id, user: u }, BOT);
const contactFor = (u, phone) => sign({ contact: { user_id: u.id, phone_number: phone, first_name: u.first_name }, auth_date: now() }, BOT);
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };

let db, S, browser;
const q = async (sql, p) => (await db.query(sql, p)).rows;

const stub = (init, user, contact) => `window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{user:${JSON.stringify(user)}},platform:'unknown',colorScheme:'dark',
themeParams:{bg_color:'#141012',text_color:'#f4ece6'},version:'7.10',ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},
BackButton:{show(){},hide(){},onClick(){}},MainButton:{show(){},hide(){},setText(){},onClick(){}},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
requestContact(cb){ setTimeout(function(){ cb(true,{status:'sent',response:${JSON.stringify(contact || '')}}); },50); },
showConfirm(m,cb){cb(true)},close(){}}};`;

async function openApp(init, user, contact, qs = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'uk-UA' });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', r => r.fulfill({ contentType: 'application/javascript', body: stub(init, user, contact) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.goto(BASE + '/p/app.html' + qs);
  return page;
}
const shot = (page, name, full) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const saved = { users: [], masters: [] };
const apptIds = [];

(async () => {
  if (!process.env.QA_DB_URL) { console.error('QA_DB_URL не задан'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  const M = (await q(`SELECT u.id AS uid, u.phone, u.master_id, m.name FROM users u JOIN roles r ON r.id=u.role_id JOIN masters m ON m.id=u.master_id
                 WHERE r.code='master' AND u.is_active AND u.merged_into IS NULL AND u.telegram_id IS NULL AND m.telegram_id IS NULL
                   AND m.active AND length(regexp_replace(COALESCE(u.phone,''),'\\D','','g'))>=9 ORDER BY u.id LIMIT 1`))[0];
  if (!M) { console.error('у QA немає майстра з обліковкою і телефоном'); process.exit(2); }
  saved.users.push((await q(`SELECT id, telegram_id, phone FROM users WHERE id=$1`, [M.uid]))[0]);
  saved.masters.push((await q(`SELECT id, telegram_id, phone FROM masters WHERE id=$1`, [M.master_id]))[0]);
  // записи майстра: сьогодні (щойно почалась) + завтра + 2 на тижні, щоб плитки «сьогодні/завтра/тиждень» були живі
  for (const [sh, st, nm] of [["now()-interval '5 minutes'", 'booked', 'Олена (QA)'], ["now()+interval '1 day'", 'confirmed', 'Ірина (QA)'],
    ["now()+interval '3 days'", 'booked', 'Марта (QA)'], ["now()+interval '5 days'", 'booked', 'Дарина (QA)']]) {
    apptIds.push((await q(`INSERT INTO appointments (tenant_id, master_id, client_name, status, starts_at, ends_at, price, source)
      VALUES ($1,$2,$3,$4, ${sh}, ${sh}+interval '1 hour', 600, 'qa-p2-e2e') RETURNING id`, [TID, M.master_id, nm, st]))[0].id);
  }
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '7899000002', BOT_TEXT_BOOKING: '' } });
  browser = await chromium.launch();
  const mphone = '+' + String(M.phone).replace(/\D/g, '');
  try {
    // 1. клієнт без телефону → мʼяко просимо номер при вході
    const u1 = mkUser('Оксана');
    let p = await openApp(initFor(u1), u1, contactFor(u1, '+38067' + String(1e6 + Math.floor(Math.random() * 8.9e6))));
    await p.waitForSelector('#share-phone', { timeout: 8000 }).catch(() => {});
    ok('1. клієнт без телефону → просимо номер (кнопка «Поділитися номером»)', await p.$('#share-phone'), 'лист номера відкрився сам при вході');
    await shot(p, '01-client-no-phone');
    await p.click('#share-phone'); await pause(900);
    const c1 = (await q(`SELECT phone FROM clients WHERE telegram_id=$1`, [u1.id]))[0];
    ok('   номер з Telegram збережено у форматі 380…', c1 && /^\+?380\d{9}$/.test(c1.phone), c1 && c1.phone);
    ok('   звичайний клієнт не бачить перемикача майстра', !(await p.$('#mode-seg')));
    await shot(p, '01b-client-home');
    await p.context().close();

    // 2. номер майстра, введений вручну → прав майстра немає
    const u2 = mkUser('Самозванець');
    p = await openApp(initFor(u2), u2, contactFor(u2, '+380501112233'));
    await p.waitForSelector('#phone-in', { timeout: 8000 });
    await p.fill('#phone-in', mphone);
    const nmIn = await p.$('.sheet input:not(#phone-in)'); if (nmIn) await nmIn.fill('Тест');
    await p.click('#save-phone'); await pause(900);
    ok('2. ручний номер майстра → перемикача «Я майстер» немає', !(await p.$('#mode-seg')));
    const sess2 = await p.evaluate(async (init) => (await fetch('/api/miniapp/master/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: '{}' })).status, initFor(u2));
    ok('   сесія майстра для ручного номера → 403', sess2 === 403, 'HTTP ' + sess2);
    ok('   Telegram самозванця до майстра не привʼязано', (await q(`SELECT telegram_id FROM users WHERE id=$1`, [M.uid]))[0].telegram_id === null);
    await shot(p, '02-manual-phone-no-master');
    await p.context().close();

    // 3. номер майстра з контакту Telegram → режим майстра зі статистикою
    const u3 = mkUser(M.name.split(' ')[0]);
    p = await openApp(initFor(u3), u3, contactFor(u3, mphone));
    await p.waitForSelector('#share-phone', { timeout: 8000 });
    await p.click('#share-phone');
    await p.waitForSelector('#mode-seg', { timeout: 8000 }).catch(() => {});
    ok('3. номер майстра з Telegram → зʼявився перемикач «Я клієнт | Я майстер»', await p.$('#mode-seg'));
    await shot(p, '03-master-recognized-home');
    await p.click('#mode-master');
    await p.waitForSelector('#k-earned', { timeout: 10000 }).catch(() => {});
    const kp = await p.$$eval('.kpi', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    ok('   кабінет майстра: плитки статистики', kp.length >= 10, kp.slice(0, 12).join(' | '));
    const today = await p.$$eval('#mtoday .row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    ok('   «Клієнти сьогодні» — свій запис з кнопкою «Не прийшов»', today.some(t => /Олена/.test(t) && /Не прийшов/.test(t)), today.join(' / '));
    await shot(p, '04-master-stats', true);
    // 4. чуже → 403 (токен сесії майстра з цієї ж сторінки)
    const r403 = await p.evaluate(async (init) => {
      const s = await (await fetch('/api/miniapp/master/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: '{}' })).json();
      const H = { Authorization: 'Bearer ' + s.token };
      const st = async (u, m) => (await fetch(u, { method: m || 'GET', headers: { ...H, 'Content-Type': 'application/json' }, body: m ? '{}' : undefined })).status;
      return { own: await st('/api/me/stats'), payMy: await st('/api/payouts/my'), sheet: await st('/api/payouts/sheet'), rules: await st('/api/payouts/rules'),
        mastersAll: await st('/api/payouts/records/1/payments') };
    }, initFor(u3));
    ok('4. своє → 200 (статистика, своя зарплата)', r403.own === 200 && r403.payMy === 200, JSON.stringify(r403));
    ok('   чуже/хазяйське → 403 (відомість салону, правила ЗП, виплати)', r403.sheet === 403 && r403.rules === 403 && r403.mastersAll === 403, JSON.stringify(r403));
    // «Не прийшов» на сьогоднішній запис
    const nsBtn = await p.$('#mtoday button.ns');
    if (nsBtn) { await nsBtn.click(); await pause(1200); }
    const st0 = (await q(`SELECT status FROM appointments WHERE id=$1`, [apptIds[0]]))[0].status;
    ok('   «Не прийшов» → статус noshow', st0 === 'noshow', st0);
    await shot(p, '05-master-noshow');
    await p.context().close();

    // 5. екран «Я майстер салону» (заявка) для звичайного клієнта
    const u5 = mkUser('Нова майстриня');
    await db.query(`INSERT INTO clients (phone, name, telegram_id, source) VALUES ($1,$2,$3,'miniapp')`, ['+38063' + String(1e6 + Math.floor(Math.random() * 8.9e6)), 'QA P2', u5.id]);
    p = await openApp(initFor(u5), u5, contactFor(u5, '+38063' + String(1e6 + Math.floor(Math.random() * 8.9e6))));
    await p.waitForSelector('#mi-claim', { timeout: 8000 }).catch(() => {});
    await shot(p, '06-client-home-claim-button');
    await p.click('#mi-claim'); await p.waitForSelector('.pick', { timeout: 8000 });
    const picks = await p.$$eval('.pick', els => els.map(e => e.textContent));
    ok('5. «Я майстер салону»: список працюючих майстрів без привʼязки', picks.length > 0, picks.join(', '));
    await p.click('.pick'); await p.click('#claim-send');
    await p.waitForSelector('#share-phone', { timeout: 5000 }).catch(() => {});
    ok('   для заявки вимагається номер саме з Telegram (ручного поля немає)', (await p.$('#share-phone')) && !(await p.$('#phone-in')));
    await p.click('#share-phone'); await pause(1500);
    const cl = (await q(`SELECT status FROM master_claims WHERE tg_user_id=$1`, [u5.id]))[0];
    ok('   заявка створена зі статусом pending (прав ще немає)', cl && cl.status === 'pending');
    await shot(p, '07-claim-sent');
    await p.context().close();
  } catch (e) {
    ok('сценарій без винятків', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    const c = (sql, prm) => db.query(sql, prm).catch(e => console.error('cleanup:', e.message));
    await c(`DELETE FROM audit_log WHERE entity='appointment' AND entity_id = ANY($1::int[])`, [apptIds]);
    await c(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [apptIds]);
    await c(`DELETE FROM user_tokens WHERE user_id = ANY($1::int[])`, [saved.users.map(u => u.id)]);
    for (const u of saved.users) await c(`UPDATE users SET telegram_id=$2, phone=$3 WHERE id=$1`, [u.id, u.telegram_id, u.phone]);
    for (const m of saved.masters) await c(`UPDATE masters SET telegram_id=$2, phone=$3 WHERE id=$1`, [m.id, m.telegram_id, m.phone]);
    await c(`DELETE FROM master_claims WHERE tg_user_id = ANY($1::bigint[])`, [uids]);
    await c(`DELETE FROM clients WHERE telegram_id = ANY($1::bigint[])`, [uids]);
    const left = (await q(`SELECT (SELECT count(*) FROM clients WHERE telegram_id = ANY($1::bigint[]))::int c, (SELECT count(*) FROM users WHERE telegram_id = ANY($1::bigint[]))::int u`, [uids]))[0];
    console.log('прибрано QA: клієнтів', left.c, 'обліковок', left.u);
    const errs = S ? S.log().split('\n').filter(l => /\[miniapp|master-link|me\/|Error/.test(l)) : [];
    if (errs.length) console.log('server log:\n' + errs.slice(-15).join('\n'));
    if (S) S.stop(); await db.end();
    const fail = results.filter(r => !r.pass).length;
    fs.writeFileSync(path.join(OUT, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), viewport: '390x844', passed: results.length - fail, failed: fail, results }, null, 1));
    console.log(`ПІДСУМОК: ${results.length - fail}/${results.length}`);
    process.exit(fail ? 1 : 0);
  }
})();
