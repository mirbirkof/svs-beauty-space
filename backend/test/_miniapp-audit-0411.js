// Незалежний аудит Mini App (04.11, «другий погляд»): новий і існуючий клієнт, шторка номера, кабінет,
// безпека (чужі записи / без підпису), «Звʼязатися з адміністратором», вихід з «Акцій».
// Запуск: node test/_miniapp-audit-0411.js — ЛИШЕ QA_DB_URL, прод не чіпається. Створене прибирається.
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = Number(process.env.AUD_PORT || 3081);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'miniapp-audit-0411');
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const now = () => Math.floor(Date.now() / 1000);
const uids = []; const clientIds = [];
const mkUser = (n) => { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_aud_' + id }; };
const initFor = (u, tok = BOT) => sign({ auth_date: now(), query_id: 'AAa' + u.id, user: u }, tok);
const contactFor = (u, phone) => sign({ auth_date: now(), contact: JSON.stringify({ user_id: u.id, phone_number: phone, first_name: u.first_name }) }, BOT);
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const firstLine = (e) => String(e && e.message || e).split('\n')[0];
let db, S, browser;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function api(init, method, url, body) {
  const h = { 'Content-Type': 'application/json' }; if (init != null) h['X-Telegram-Init-Data'] = init;
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const stub = (init, user, contact) => `window.__tg={back:0,hs:0};
window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{user:${JSON.stringify(user)}},platform:'android',colorScheme:'dark',
themeParams:{bg_color:'#17212b',text_color:'#f5f5f5'},version:'8.0',isVersionAtLeast(v){return parseFloat(v)<=8},
ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},onEvent(){},requestFullscreen(){},disableVerticalSwipes(){},
addToHomeScreen(){__tg.hs++},checkHomeScreenStatus(cb){cb('missed')},
requestContact(cb){ ${contact ? `cb(true,{response:${JSON.stringify(contact)}})` : 'cb(false)'} },
BackButton:{_cb:null,isVisible:false,show(){this.isVisible=true;__tg.back++},hide(){this.isVisible=false},onClick(f){this._cb=f}},
MainButton:{show(){},hide(){},setText(){},onClick(){}},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
showConfirm(m,cb){cb(true)},close(){}}};`;
async function openApp(init, user, { contact = null, askPhone = true, vw = 390, vh = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, locale: 'uk-UA', hasTouch: true, isMobile: true });
  if (!askPhone) await ctx.addInitScript(() => { try { localStorage.setItem('svs_phone_ask', String(Date.now())); } catch (_) {} });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', r => r.fulfill({ contentType: 'application/javascript', body: stub(init, user, contact) }));
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => ok('без JS-помилок', false, e.message));
  await page.goto(BASE + '/p/app.html');
  await page.waitForSelector('#go-book');
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const text = (page) => page.evaluate(() => document.body.innerText);
const clickText = (page, re) => page.evaluate((src) => { const r = new RegExp(src, 'i'); const b = [...document.querySelectorAll('button')].find(x => r.test(x.textContent)); if (b) b.click(); return !!b; }, re);

async function anyService() {
  return (await q(`SELECT ms.master_id, ms.service_id FROM master_services ms JOIN masters m ON m.id=ms.master_id
     JOIN services s ON s.id=ms.service_id WHERE m.active AND ms.active IS NOT FALSE AND s.active IS NOT FALSE LIMIT 1`))[0];
}
async function mkClient(name, phone, tgId) {
  const id = (await q(`INSERT INTO clients (phone, name, telegram_id, source) VALUES ($1,$2,$3,'qa-audit') RETURNING id`, [phone, name, tgId || null]))[0].id;
  clientIds.push(id); return id;
}
async function mkAppt(clientId, ms, status, when) {
  return (await q(`INSERT INTO appointments (tenant_id, master_id, service_id, client_id, client_name, status, starts_at, ends_at, price, source)
    VALUES ($1,$2,$3,$4,'QA audit',$5, ${when}, ${when}+interval '1 hour', 500, 'qa-audit') RETURNING id`, [TENANT, ms.master_id, ms.service_id, clientId, status]))[0].id;
}
const rndPhone = () => '+38067' + String(1e6 + Math.floor(Math.random() * 8.9e6));

// ── 1. Новий клієнт: шторка номера при першому вході, ручний номер, кабінет ──
async function newClient() {
  const U = mkUser('Оксана');
  const page = await openApp(initFor(U), U);
  await pause(1600);
  const sheet = await page.$('.sheet'); await shot(page, '01-new-first-open');
  ok('новий клієнт: при першому вході зʼявляється «Ваш номер телефону»', sheet && /Ваш номер/.test(await text(page)));
  ok('шторка: є «Поділитися номером з Telegram» і ручне введення', !!(await page.$('#share-phone')) && !!(await page.$('#phone-in')));
  const ph = rndPhone();
  await page.fill('#phone-in', ph); await page.click('#save-phone'); await pause(900);
  ok('ручний номер збережено, шторка закрилась', !(await page.$('.sheet')));
  const c = (await q(`SELECT id, phone FROM clients WHERE telegram_id=$1`, [U.id]))[0];
  ok('у QA-базі створено картку з номером', c && String(c.phone).replace(/\D/g, '').endsWith(ph.replace(/\D/g, '').substring(4)));
  if (c) clientIds.push(c.id);
  await clickText(page, 'Мої записи|кабінет');
  await pause(1200); await shot(page, '02-new-cabinet');
  const t = await text(page);
  ok('кабінет нового клієнта: порожній стан і кнопка запису', /немає (майбутніх )?записів|Поки немає|ще немає/i.test(t) && /Записатися/.test(t), flat(t));
  await page.context().close();
}

// ── 2. Тап «Записатися» одразу після відкриття — шторка не має перекрити категорії ──
async function quickTap() {
  const U = mkUser('Дана');
  const page = await openApp(initFor(U), U);
  const t0 = Date.now(); await page.click('#go-book', { timeout: 5000 }); const dt = Date.now() - t0;
  await pause(1500); await shot(page, '03-quick-tap');
  ok('швидкий тап «Записатися»: шторка номера не вистрибує поверх категорій', !(await page.$('.sheet')), 'клік за ' + dt + ' мс');
  await page.context().close();
}

// ── 3. Існуючий клієнт CRM (картка без Telegram, є історія) ──
async function existingClient(ms) {
  const U = mkUser('Галина'); const phone = rndPhone();
  const cid = await mkClient('Галина QA-аудит', phone, null);
  await mkAppt(cid, ms, 'done', "now()-interval '20 days'");
  const fut = await mkAppt(cid, ms, 'booked', "date_trunc('hour', now())+interval '3 days'");
  // а) закрила шторку → кабінет
  let page = await openApp(initFor(U), U, { contact: contactFor(U, phone.replace('+', '')) });
  await pause(1600);
  await clickText(page, '^Скасувати$');
  await pause(300);
  await clickText(page, 'Мої записи|кабінет');
  await pause(1200); await shot(page, '04-existing-skipped-phone-cabinet');
  let t = await text(page);
  ok('існуючий клієнт без номера: кабінет пропонує поділитися номером, а не «немає записів»', /Поділитися номером/i.test(t), flat(t));
  // б) ручне введення номера, що вже є в базі → прохання підтвердити кнопкою
  const r1 = await api(initFor(U), 'POST', '/contact', { phone, name: 'X' });
  ok('ручний номер наявної картки → need_verified (захист від захоплення)', r1.status === 409 && r1.body.error === 'need_verified');
  // в) поділилась номером через Telegram → картка привʼязана, історія видна
  if (await clickText(page, 'Поділитися номером')) { await pause(600); if (await page.$('#share-phone')) await page.click('#share-phone'); await pause(1800); }
  await shot(page, '05-existing-after-share');
  t = await text(page);
  ok('після «Поділитися» кабінет показує імʼя і запис наперед', /Галина/.test(t) && /попереду/.test(t), flat(t));
  const link = (await q(`SELECT telegram_id FROM clients WHERE id=$1`, [cid]))[0];
  ok('картка CRM привʼязана до Telegram', link && Number(link.telegram_id) === U.id);
  await page.context().close();
  // г) повторне відкриття: шторки більше немає
  page = await openApp(initFor(U), U, { askPhone: true });
  await pause(1500); await shot(page, '06-existing-home');
  ok('існуючий клієнт: шторка номера більше не зʼявляється', !(await page.$('.sheet')), flat(await text(page)));
  await page.context().close();
  return { U, cid, fut };
}

// ── 4. Безпека ──
async function security(owner) {
  const r0 = await api(null, 'GET', '/me');
  ok('без initData → 401', r0.status === 401, String(r0.status));
  const U = mkUser('Злий');
  const r1 = await api(initFor(U, '7000000001:WRONG'), 'GET', '/me');
  ok('чужий/підроблений підпис → 401', r1.status === 401, String(r1.status));
  const old = sign({ auth_date: now() - 2 * 86400, query_id: 'x', user: U }, BOT);
  const r2 = await api(old, 'GET', '/me');
  ok('initData старше доби → 401', r2.status === 401, String(r2.status));
  await mkClient('Злий QA', rndPhone(), U.id);
  const iU = initFor(U);
  const my = await api(iU, 'GET', '/my');
  ok('кабінет чужого не видно', my.status === 200 && !(my.body.upcoming || []).some(a => +a.id === +owner.fut));
  const mi = await api(iU, 'GET', '/move-info?ids=' + owner.fut);
  ok('чужий запис: /move-info → 404', mi.status === 404, String(mi.status));
  const cn = await api(iU, 'POST', '/cancel', { ids: [owner.fut] });
  const st = (await q(`SELECT status FROM appointments WHERE id=$1`, [owner.fut]))[0].status;
  ok('чужий запис: /cancel не скасовує', cn.status >= 400 && st === 'booked', cn.status + ' / ' + st);
  const ct = await api(iU, 'POST', '/contact', { contact: contactFor(owner.U, '380671234567') });
  ok('чужий підписаний контакт не приймається', ct.status === 400, String(ct.status));
}

// ── 5. «Звʼязатися з адміністратором» і «Акції» ──
async function adminAndPromos() {
  const U = mkUser('Віра');
  const a1 = await api(initFor(U), 'POST', '/admin-contact');
  const a2 = await api(initFor(U), 'POST', '/admin-contact');
  ok('admin-contact: повтор за 15 с не спамить', a2.status === 200 && a2.body && a2.body.repeated, a1.status + ' ' + JSON.stringify(a1.body) + ' ; ' + JSON.stringify(a2.body));
  const page = await openApp(initFor(U), U, { askPhone: false });
  if (!(await clickText(page, 'Акції'))) { ok('пункт «Акції та новини» є', false); await page.context().close(); return; }
  await pause(1800); await shot(page, '07-promos');
  const inApp = await page.evaluate(() => location.pathname);
  const back = await page.evaluate(() => !!(window.Telegram && Telegram.WebApp && Telegram.WebApp.BackButton && Telegram.WebApp.BackButton.isVisible));
  const t = await text(page);
  ok('«Акції»: відкриваються всередині застосунку з кнопкою «назад»', /app\.html/.test(inApp) && back, inApp + ' back=' + back);
  ok('«Акції»: видно акцію салону або порожній стан', /Перший візит|Акцій зараз немає/i.test(t), flat(t));
  if (back) { await page.evaluate(() => Telegram.WebApp.BackButton._cb && Telegram.WebApp.BackButton._cb()); await pause(500); ok('«Акції» → назад → головна', !!(await page.$('#go-book'))); }
  await page.context().close();
}

async function cleanup() {
  const cl = await q(`SELECT id FROM clients WHERE telegram_id = ANY($1::bigint[]) OR id = ANY($2::int[])`, [uids, clientIds]);
  const ids = cl.map(r => r.id);
  if (ids.length) {
    const aps = (await q(`SELECT id FROM appointments WHERE client_id = ANY($1::int[])`, [ids])).map(r => r.id);
    if (aps.length) {
      for (const t of ['online_bookings', 'booking_reminders', 'notification_log']) await q(`DELETE FROM ${t} WHERE appointment_id = ANY($1::int[])`, [aps]).catch(() => {});
      await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [aps]).catch(e => console.error('cleanup appts:', e.message));
    }
    await q(`DELETE FROM clients WHERE id = ANY($1::int[])`, [ids]).catch(e => console.error('cleanup clients:', e.message));
  }
  console.log('прибрано QA: клієнтів ' + ids.length);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!process.env.QA_DB_URL || process.env.QA_DB_URL === process.env.DATABASE_URL) throw new Error('QA_DB_URL порожній або = DATABASE_URL — стоп');
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  browser = await chromium.launch();
  let fatal = null;
  try {
    const ms = await anyService();
    const step = async (n, f) => { try { return await f(); } catch (e) { ok(n + ' без збоїв', false, firstLine(e)); } };
    await step('новий клієнт', newClient);
    await step('швидкий тап', quickTap);
    const owner = await step('існуючий клієнт', () => existingClient(ms));
    if (owner) await step('безпека', () => security(owner));
    await step('адмін/акції', adminAndPromos);
  } catch (e) { fatal = e; console.error(e); }
  finally {
    await browser.close().catch(() => {});
    await cleanup().catch(e => console.error('cleanup:', e.message));
    S.stop(); await db.end().catch(() => {});
  }
  const fail = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\nПІДСУМОК аудиту: ${results.length - fail.length}/${results.length} ✔` + (fail.length ? `, ✘ ${fail.length}` : ''));
  process.exit(fatal || fail.length ? 1 : 0);
})();
