// УСТАРЕЛО з combo-0411 (04.11): кнопок #next-master/#next-time більше немає — послуга → одразу час, тап на слот → підтвердження. Актуальний прохід: test/_miniapp-combo-0411.js
// Браузерний e2e Mini App (Босс 03.11): Chromium 390×844, підписаний initData, ЛИШЕ QA-база.
// Запуск: node test/_miniapp-e2e-0311.js  (не входить у щит: префікс «_»).
// Скріншоти → ../reports/miniapp-0311/. Усе створене (клієнти 77xxxxxxxx, записи, графік qa-miniapp-e2e) прибирається.
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = 3061;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'miniapp-0311');
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const FIX_SRC = 'qa-miniapp-e2e';
const now = () => Math.floor(Date.now() / 1000);
const uids = [];
const mkUser = (n) => { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_e2e_' + id }; };
const initFor = (u, ad = now(), tok = BOT) => sign({ auth_date: ad, query_id: 'AAe' + u.id, user: u }, tok);
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };

let db, S, browser;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function api(init, method, url, body) {
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// заглушка telegram-web-app.js: справжній SDK недоступний поза Telegram, тож віддаємо обʼєкт WebApp з підписаним initData
const stub = (init, user) => `window.__tg={expand:0,ready:0,back:0,haptic:0};
window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{user:${JSON.stringify(user)}},platform:'unknown',colorScheme:'dark',
themeParams:{bg_color:'#141012',text_color:'#f4ece6'},version:'7.10',
ready(){__tg.ready++},expand(){__tg.expand++},setHeaderColor(){},setBackgroundColor(){},
BackButton:{_cb:null,isVisible:false,show(){this.isVisible=true;__tg.back++},hide(){this.isVisible=false},onClick(f){this._cb=f}},
MainButton:{show(){},hide(){},setText(){},onClick(){}},
HapticFeedback:{impactOccurred(){__tg.haptic++},notificationOccurred(){__tg.haptic++},selectionChanged(){__tg.haptic++}},
showConfirm(m,cb){cb(true)},close(){}}};`;

async function openApp(init, user, qs = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'uk-UA' });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', r => r.fulfill({ contentType: 'application/javascript', body: stub(init, user) }));
  const page = await ctx.newPage();
  page.__api = []; page.on('response', r => { if (r.url().includes('/api/miniapp/')) page.__api.push(r.status()); });
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.goto(BASE + '/p/app.html' + qs);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function setupFixture(init) {
  const cat = await api(init, 'GET', '/catalog');
  const svcs = cat.body.categories.flatMap(c => c.services.map(s => ({ ...s, cat: c.name }))).filter(s => +s.duration_min >= 30 && +s.duration_min <= 90);
  for (const s of svcs) {
    const m = ((await api(init, 'GET', '/masters?service=' + s.id)).body.masters || [])[0]; if (!m) continue;
    const d0 = (await q(`SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date + 2)::text d`))[0].d;
    if ((await q(`SELECT 1 FROM master_schedule_days WHERE master_id=$1 AND work_date BETWEEN $2::date AND $2::date + 3`, [m.id, d0])).length) continue;
    await q(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, tenant_id, source)
             SELECT $1, $2::date + i, '10:00', '18:00', $3, $4 FROM generate_series(0,2) i`, [m.id, d0, TENANT, FIX_SRC]);
    const empty = (await q(`SELECT ($1::date + 3)::text d`, [d0]))[0].d;
    const slots = (await api(init, 'GET', `/slots?service=${s.id}&master=${m.id}&date=${d0}`)).body.slots || [];
    return { svc: s, master: m, date: d0, empty, slots };
  }
  throw new Error('немає послуги з вільним майстром для фікстури');
}

// пройти 4 кроки до екрану підтвердження
async function walkToConfirm(page, P, slotMin, tag) {
  await page.click('#go-book');
  await page.waitForSelector('.row');
  if (tag) await shot(page, tag + '-1-categories');
  await page.locator('.row', { hasText: P.svc.cat }).first().click();
  await page.waitForSelector('.svc');
  await page.locator('.svc', { hasText: P.svc.name }).first().click();
  await page.waitForSelector(`.mst[data-id="${P.master.id}"]`);
  await page.click(`.mst[data-id="${P.master.id}"]`);
  if (tag) await shot(page, tag + '-2-master');
  await page.click('#next-master');
  await page.waitForSelector('.day');
  if (!(await page.$(`.day[data-date="${P.date}"]`))) await page.click('[aria-label="Наступний тиждень"]');
  await page.click(`.day[data-date="${P.date}"]`);
  await page.waitForSelector(`.slot[data-min="${slotMin}"]`);
  await page.click(`.slot[data-min="${slotMin}"]`);
  if (tag) await shot(page, tag + '-3-time');
  await page.click('#next-time');
  await page.waitForSelector('#confirm-btn');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  // запобіжник: це має бути QA, не прод
  if (process.env.QA_DB_URL === process.env.DATABASE_URL) throw new Error('QA_DB_URL збігається з DATABASE_URL — стоп');
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  browser = await chromium.launch();
  try {
    const A = mkUser('Олена'); const initA = initFor(A);
    const P = await setupFixture(initA);
    const mins = P.slots.map(s => s.start_min); const at = (k) => mins.find(m => m >= mins[0] + k * 120);
    const [s0, s1, s2, s3] = [mins[0], at(1), at(2), at(3)];
    if ([s1, s2, s3].some(v => v == null)) throw new Error('замало слотів з кроком 2 год');
    console.log(`фікстура: ${P.svc.name} / ${P.master.name} / ${P.date}, слотів ${P.slots.length}`);

    // 1. головний екран
    let page = await openApp(initA, A);
    await page.waitForSelector('#go-book');
    await shot(page, '01-home');
    const html = await page.content();
    ok('головний: SVS BEAUTY SPACE, Записатися, 4 пункти меню',
      /SVS/.test(html) && /BEAUTY SPACE/.test(html) && /Записатися/.test(html) && ['Послуги', 'Наші майстри', 'Акції та новини', 'Мої записи / кабінет'].every(t => html.includes(t)));
    const tgc = await page.evaluate(() => window.__tg);
    ok('Telegram.WebApp: ready()+expand() викликані', tgc.ready >= 1 && tgc.expand >= 1, JSON.stringify(tgc));
    ok('«Оплата онлайн» не показано', !/Оплата онлайн/i.test(html));

    // 2. 4 кроки + телефон один раз + бронь
    await walkToConfirm(page, P, s0, '02');
    ok('прогрес-бар 4/4 на підтвердженні', /4\/4|4 \/ 4/.test(await page.content()));
    ok('BackButton показано в глибині', await page.evaluate(() => Telegram.WebApp.BackButton.isVisible));
    ok('тумблер «Нагадати за 24 год» є', !!(await page.$('#remind-toggle')) && /Нагадати за 24/.test(await page.content()));
    await shot(page, '02-4-confirm');
    // подвійний тап по «Підтвердити»
    await page.evaluate(() => { const b = document.getElementById('confirm-btn'); b.click(); b.click(); });
    await page.waitForSelector('#phone-in');
    await shot(page, '03-phone-once');
    await page.fill('#phone-in', '+38099' + String(1000000 + Math.floor(Math.random() * 8999999)));
    await page.click('#save-phone');
    await page.waitForSelector('#to-cabinet', { timeout: 15000 });
    await shot(page, '04-done');
    const cA = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [A.id]))[0];
    const apA = await q(`SELECT a.id, a.status, a.source FROM appointments a WHERE a.client_id=$1`, [cA.id]);
    const obA = await q(`SELECT channel FROM online_bookings WHERE appointment_id = ANY($1::int[])`, [apA.map(r => r.id)]);
    ok('бронь у БД: 1 запис source=miniapp + online_bookings channel=miniapp (подвійний тап)',
      apA.length === 1 && apA[0].source === 'miniapp' && obA.length === 1 && obA[0].channel === 'miniapp', `appointments=${apA.length}, ob=${obA.map(r => r.channel)}`);
    // ще один подвійний тап — уже з телефоном (без шторки): dblclick → 1 запис
    await page.click('text=На головну');
    await walkToConfirm(page, P, s2);
    await page.dblclick('#confirm-btn');
    await page.waitForSelector('#to-cabinet', { timeout: 15000 });
    const apA2 = await q(`SELECT id FROM appointments WHERE client_id=$1 AND status<>'cancelled'`, [cA.id]);
    ok('dblclick «Підтвердити» = рівно 1 нова бронь', apA2.length === 2, `усього записів у клієнта: ${apA2.length}`);

    // 3. зайнятий слот: B на екрані підтвердження, тим часом C бронює той самий час
    const B = mkUser('Ірина'); const initB = initFor(B);
    await api(initB, 'POST', '/contact', { phone: '+38099' + String(1000000 + Math.floor(Math.random() * 8999999)), name: 'Ірина QA' });
    const pB = await openApp(initB, B);
    await pB.waitForSelector('#go-book');
    await walkToConfirm(pB, P, s1);
    const C = mkUser('Марта'); const initC = initFor(C);
    await api(initC, 'POST', '/contact', { phone: '+38099' + String(1000000 + Math.floor(Math.random() * 8999999)), name: 'Марта QA' });
    const rc = await api(initC, 'POST', '/book', { service_id: P.svc.id, master_id: P.master.id, date: P.date, start_min: s1 });
    await pB.click('#confirm-btn');
    const toast = await pB.waitForSelector('.toast', { timeout: 10000 }).then(e => e.textContent()).catch(() => '');
    await shot(pB, '05-slot-taken');
    const nB = (await q(`SELECT count(*)::int n FROM appointments a JOIN clients c ON c.id=a.client_id WHERE c.telegram_id=$1`, [B.id]))[0].n;
    ok('зайнятий слот: «Час щойно зайняли», брані у B немає', rc.status === 200 && /щойно зайняли/i.test(toast) && nB === 0, `toast="${toast}", C=${rc.status}, B записів=${nB}`);
    // 4. порожній день
    await pB.waitForSelector('.day');
    if (!(await pB.$(`.day[data-date="${P.empty}"]`))) await pB.click('[aria-label="Наступний тиждень"]');
    await pB.click(`.day[data-date="${P.empty}"]`);
    await pB.waitForSelector('#empty-day', { timeout: 10000 }).catch(() => null);
    await shot(pB, '06-empty-day');
    ok('порожній день → «вільного часу немає»', /вільного часу немає/.test(await pB.content()));
    await pB.context().close();

    // 5. initData: неподписаний і прострочений → 401
    for (const [tag, init] of [['07-unsigned', new URLSearchParams({ auth_date: String(now()), user: JSON.stringify(A) }).toString()], ['08-expired', initFor(A, now() - 25 * 3600)]]) {
      const pg = await openApp(init, A);
      await pause(1500); await shot(pg, tag);
      const st = pg.__api[0] || 0;
      const r2 = await api(init, 'GET', '/my');
      ok(`initData ${tag.slice(3)} → 401`, st === 401 && r2.status === 401, `браузер ${st}, /my ${r2.status} ${r2.body && r2.body.reason}`);
      await pg.context().close();
    }

    // 6. кабінет: перенос і скасування
    await page.click('text=На головну');
    await page.click('#mi-cab');
    await page.waitForSelector('.ap');
    await shot(page, '09-cabinet');
    const ups = await page.$$eval('.ap', els => els.map(e => +e.dataset.id));
    ok('кабінет: 2 майбутні записи', ups.length === 2, String(ups));
    const moveId = ups[0], cancelId = ups[1];
    await page.click(`.ap[data-id="${moveId}"] .mv`);
    await page.waitForSelector('.day');
    if (!(await page.$(`.day[data-date="${P.date}"]`))) await page.click('[aria-label="Наступний тиждень"]');
    await page.click(`.day[data-date="${P.date}"]`);
    await page.waitForSelector(`.slot[data-min="${s3}"]`);
    await page.click(`.slot[data-min="${s3}"]`);
    await shot(page, '10-move-time');
    await page.click('#next-time');
    await page.waitForSelector('#confirm-btn');
    await shot(page, '11-move-confirm');
    await page.click('#confirm-btn');
    await page.waitForSelector('#to-cabinet', { timeout: 15000 });
    await shot(page, '12-moved');
    const old = (await q(`SELECT status FROM appointments WHERE id=$1`, [moveId]))[0];
    const nw = await q(`SELECT id, status FROM appointments WHERE client_id=$1 AND status<>'cancelled' AND id<>$2`, [cA.id, cancelId]);
    ok('перенос: старий cancelled, новий активний', old.status === 'cancelled' && nw.length === 1 && nw[0].id !== moveId, `старий=${old.status}, нових=${nw.length}`);
    await page.click('#to-cabinet');
    await page.waitForSelector(`.ap[data-id="${cancelId}"] .x`);
    await page.click(`.ap[data-id="${cancelId}"] .x`);
    await page.waitForSelector('.toast');
    await pause(1200);
    await shot(page, '13-cancelled');
    const cs = (await q(`SELECT status FROM appointments WHERE id=$1`, [cancelId]))[0];
    ok('скасування з кабінету → cancelled', cs.status === 'cancelled', cs.status);

    // 7. «Перенести» з напоминания: ?move=ids відкриває вибір часу
    const live = nw[0].id;
    const pm = await openApp(initA, A, '?move=' + live);
    await pm.waitForSelector('.day', { timeout: 15000 });
    await shot(pm, '14-move-from-reminder');
    ok('?move=id з напоминания відкриває вибір часу', !!(await pm.$('.day')));
    await pm.context().close();
    // 8. майстри
    await page.click('text=На головну').catch(() => {});
    await page.goto(BASE + '/p/app.html'); await page.waitForSelector('#go-book');
    await page.click('text=Наші майстри'); await pause(1500);
    await shot(page, '15-team');
    const stars = await page.$$eval('.rt', els => els.length);
    const rated = (await q(`SELECT count(DISTINCT master_id)::int n FROM visit_ratings WHERE master_stars IS NOT NULL`))[0].n;
    ok('рейтинг «★» лише в майстрів з реальними оцінками', rated > 0 || stars === 0, `★ на екрані: ${stars}, майстрів з оцінками в БД: ${rated}`);
  } catch (e) {
    ok('сценарій без винятків', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    // прибирання QA
    await q(`DELETE FROM master_schedule_days WHERE source=$1`, [FIX_SRC]).catch(e => console.error('cleanup sched', e.message));
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
    const left = (await q(`SELECT count(*)::int n FROM clients WHERE telegram_id = ANY($1::bigint[])`, [uids]))[0].n;
    console.log('прибрано QA: клієнтів лишилось', left);
    const errs = S.log().split('\n').filter(l => /\[miniapp|booking-core|Error/.test(l));
    if (errs.length) console.log('server log:\n' + errs.slice(-15).join('\n'));
    S.stop(); await db.end();
    const fail = results.filter(r => !r.pass).length;
    fs.writeFileSync(path.join(OUT, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), viewport: '390x844', passed: results.length - fail, failed: fail, results }, null, 1));
    console.log(`ПІДСУМОК: ${results.length - fail}/${results.length}`);
    process.exit(fail ? 1 : 0);
  }
})();
