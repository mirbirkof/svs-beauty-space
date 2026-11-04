// Візуальний тест Mini App «очима клієнта» (Босс 04.11: «видно лише 4 послуги, немає пошуку»).
// Запуск: VIS_TAG=after node test/_miniapp-visual-0411.js   (не входить у щит: префікс «_»).
//  • Відображення каталогу — на ЗНІМКУ прод-каталогу (test/fixtures-miniapp-prod-catalog-0411.json: назви/ціни/тривалості,
//    без клієнтів), підставленому в /catalog через перехоплення браузера. Групування — тим самим кодом, що й на сервері.
//  • Шлях запису (майстер → дата → час → бронь → «Мої записи» → перенос → скасування) — по-справжньому на QA-сервері
//    поверх QA_DB_URL. Прод не чіпається. Створене (клієнти 77xxxxxxxx, записи, графік qa-miniapp-vis) прибирається.
//  • Екрани: 390×844 (iPhone) і 360×740 (малий Android), тема Telegram світла і темна.
//  • На кожному кроці: скрін + перевірки (обрізаний текст, горизонтальний скрол, ціна/тривалість у кадрі,
//    останній пункт не під нижньою кнопкою, порожні стани, повільна мережа, подвійний тап, назад).
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const TAG = process.env.VIS_TAG || 'after';
const PORT = Number(process.env.VIS_PORT || 3071);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'miniapp-ux-0411', TAG);
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const FIX_SRC = 'qa-miniapp-vis';
const PROD_ROWS = require('./fixtures-miniapp-prod-catalog-0411.json');
let groupCatalog = null; try { groupCatalog = require('../lib/miniapp-catalog').groupCatalog; } catch (_) {}
// «до»: так групував старий /catalog — сира категорія з БД
function oldGroup(rows) {
  const g = new Map();
  for (const s of rows) { const c = (s.category || '').trim() || 'Інші послуги'; if (!g.has(c)) g.set(c, []); g.get(c).push(s); }
  return [...g.entries()].map(([name, services]) => ({ name, count: services.length, services }));
}
const prodCatalog = () => ({ categories: groupCatalog ? groupCatalog(PROD_ROWS) : oldGroup(PROD_ROWS) });

const now = () => Math.floor(Date.now() / 1000);
const uids = [];
const mkUser = (n) => { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_vis_' + id }; };
const initFor = (u) => sign({ auth_date: now(), query_id: 'AAv' + u.id, user: u }, BOT);
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };

let db, S, browser;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function api(init, method, url, body) {
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const THEMES = {
  dark: { scheme: 'dark', params: { bg_color: '#17212b', text_color: '#f5f5f5', button_color: '#5288c1', secondary_bg_color: '#232e3c' } },
  light: { scheme: 'light', params: { bg_color: '#ffffff', text_color: '#000000', button_color: '#2481cc', secondary_bg_color: '#f1f1f1' } },
};
const stub = (init, user, theme) => `window.__tg={expand:0,ready:0,back:0};
window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{user:${JSON.stringify(user)}},platform:'unknown',colorScheme:${JSON.stringify(theme.scheme)},
themeParams:${JSON.stringify(theme.params)},version:'7.10',
ready(){__tg.ready++},expand(){__tg.expand++},setHeaderColor(){},setBackgroundColor(){},onEvent(){},
BackButton:{_cb:null,isVisible:false,show(){this.isVisible=true;__tg.back++},hide(){this.isVisible=false},onClick(f){this._cb=f}},
MainButton:{isVisible:false,show(){this.isVisible=true},hide(){},setText(){},onClick(){}},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
showConfirm(m,cb){cb(true)},close(){}}};`;

async function openApp(init, user, { vw = 390, vh = 844, theme = 'dark', prodCat = false, slowCatalog = 0, askPhone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, locale: 'uk-UA', hasTouch: true, isMobile: true });
  // «номер уже питали сьогодні» — щоб шторка-нагадування не заважала проходам; окремо перевіряється в phoneAskPass
  if (!askPhone) await ctx.addInitScript(() => { try { localStorage.setItem('svs_phone_ask', String(Date.now())); } catch (_) {} });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', r => r.fulfill({ contentType: 'application/javascript', body: stub(init, user, THEMES[theme]) }));
  if (prodCat || slowCatalog) await ctx.route('**/api/miniapp/catalog', async r => {
    if (slowCatalog) await new Promise(res => setTimeout(res, slowCatalog));
    if (prodCat) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(prodCatalog()) });
    return r.continue();
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => { console.error('pageerror:', e.message); ok('без JS-помилок', false, e.message); });
  await page.goto(BASE + '/p/app.html');
  await page.waitForSelector('#go-book');
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const pause = (ms) => new Promise(r => setTimeout(r, ms));

// Обрізаний текст / вихід за край / перекриття нижньою кнопкою — на поточному екрані
async function layoutAudit(page) {
  return page.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight, issues = [];
    if (document.documentElement.scrollWidth > W + 1) issues.push('горизонтальний скрол сторінки: ' + document.documentElement.scrollWidth + '>' + W);
    const els = document.querySelectorAll('.screen *');
    for (const el of els) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const cs = getComputedStyle(el);
      const txt = (el.textContent || '').trim(); if (!txt || el.children.length > 3) continue;
      const r = el.getBoundingClientRect(); if (!r.width) continue;
      // вміст горизонтальної стрічки з прокруткою (чіпи) законно виходить за край — перевіряємо саму стрічку
      let sc = el.parentElement, inScroller = false;
      while (sc && sc !== document.body) { const o = getComputedStyle(sc).overflowX; if (o === 'auto' || o === 'scroll') { inScroller = true; break; } sc = sc.parentElement; }
      if (inScroller) continue;
      const clips = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
      if (clips && el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'INPUT') issues.push('обрізано: «' + txt.slice(0, 50) + '» ' + el.scrollWidth + '>' + el.clientWidth);
      if (r.right > W + 1 || r.left < -1) issues.push('за краєм екрана: «' + txt.slice(0, 40) + '» [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    }
    // ціна і тривалість кожної видимої послуги — повністю в кадрі по ширині
    for (const s of document.querySelectorAll('.svc')) {
      const p = s.querySelector('.p'), m = s.querySelector('.m');
      if (!p || !m || !p.textContent.trim() || !m.textContent.trim()) { issues.push('без ціни/тривалості: «' + s.textContent.slice(0, 40) + '»'); continue; }
      const pr = p.getBoundingClientRect(); if (pr.right > W || pr.left < 0) issues.push('ціна за краєм: «' + s.textContent.slice(0, 40) + '»');
    }
    // нижня кнопка (.fixed) не перекриває останній елемент списку, коли прокрутили до кінця
    const fx = document.querySelector('.fixed');
    return { issues: [...new Set(issues)].slice(0, 15), fixedTop: fx ? fx.getBoundingClientRect().top : null, H };
  });
}
async function lastNotCovered(page, sel) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await pause(150);
  return page.evaluate((sel) => {
    const items = document.querySelectorAll(sel); if (!items.length) return { ok: true, why: 'немає елементів' };
    const last = items[items.length - 1].getBoundingClientRect();
    const fx = document.querySelector('.fixed'); const lim = fx ? fx.getBoundingClientRect().top + 14 : window.innerHeight;
    return { ok: last.bottom <= lim + 1, why: `низ останнього ${Math.round(last.bottom)} / межа ${Math.round(lim)}` };
  }, sel);
}
const catNames = (page) => page.$$eval('.row.cat .t, .row .t', els => [...new Set(els.map(e => e.textContent.trim()))]);

// ── 1. Відображення каталогу (прод-знімок) на 4 комбінаціях екрана/теми ──
async function displayPass(init, user, vw, vh, theme) {
  const tag = `${vw}x${vh}-${theme}`;
  const page = await openApp(init, user, { vw, vh, theme, prodCat: true });
  await shot(page, `${tag}-01-home`);
  await page.click('#go-book'); await page.waitForSelector('.row');
  await shot(page, `${tag}-02-categories`);
  const cats = await catNames(page);
  ok(`[${tag}] категорії без дублів (немає «Перукарські послуги», одна «Брови…»)`,
    !cats.some(c => /перукар/i.test(c)) && cats.filter(c => /бров|брів/i.test(c)).length <= 1, cats.join(' | '));
  let a = await layoutAudit(page); ok(`[${tag}] категорії: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
  const hasSearch = !!(await page.$('#q'));
  ok(`[${tag}] поле пошуку на екрані послуг`, hasSearch);
  if (cats.some(c => /перукар/i.test(c))) { // стара картина: окрема категорія з 4 послугами
    await page.locator('.row', { hasText: 'Перукарські' }).first().click(); await page.waitForSelector('.svc');
    await shot(page, `${tag}-02b-perukarski`); await page.click('.head .back'); await page.waitForSelector('.row');
  }

  // категорія «Волосся»
  await page.locator('.row', { hasText: 'Волосся' }).first().click(); await page.waitForSelector('.svc');
  await shot(page, `${tag}-03-hair-top`);
  const nSvc = await page.$$eval('.svc', e => e.length);
  ok(`[${tag}] «Волосся»: показано всі ${PROD_ROWS.filter(s => /волос|перукар/i.test(s.category)).length} послуг (з урахуванням злиття)`,
    nSvc === PROD_ROWS.filter(s => /волос|перукар/i.test(s.category)).length, 'видно ' + nSvc);
  const chips = await page.$$eval('.chip', e => e.map(x => x.textContent.trim()));
  ok(`[${tag}] «Волосся»: є підгрупи для навігації`, chips.length >= 3, chips.join(' | '));
  a = await layoutAudit(page); ok(`[${tag}] послуги: нічого не обрізано, ціна і тривалість у кадрі`, !a.issues.length, a.issues.join('; '));
  // найдовша назва (82 символи) повністю видна
  const longest = PROD_ROWS.reduce((m, s) => s.name.length > m.length ? s.name : m, '');
  const lv = await page.evaluate((nm) => { const el = [...document.querySelectorAll('.svc .n')].find(e => e.textContent === nm); if (!el) return null; el.scrollIntoView(); const r = el.getBoundingClientRect(); return { fits: el.scrollWidth <= el.clientWidth + 1 && r.right <= innerWidth, lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight)) }; }, longest);
  ok(`[${tag}] найдовша назва (${longest.length} симв.) влазить повністю`, lv && lv.fits, JSON.stringify(lv));
  await pause(100); await shot(page, `${tag}-04-hair-longest`);
  if (chips.length) {
    await page.locator('.chip', { hasText: /Фарбування/ }).first().click();
    for (let i = 0, y = -1; i < 30; i++) { await pause(100); const ny = await page.evaluate(() => scrollY); if (ny === y) break; y = ny; } // плавна прокрутка доїхала
    await shot(page, `${tag}-05-hair-chip`);
    const vis = await page.evaluate(() => { const g = [...document.querySelectorAll('.grp')].find(x => /Фарбування/.test(x.textContent)); if (!g) return null; const r = g.getBoundingClientRect(); const head = document.querySelector('.head'); return { top: Math.round(r.top), headBottom: Math.round((head ? head.getBoundingClientRect().bottom : 0)) }; });
    ok(`[${tag}] тап по підгрупі «Фарбування» прокручує до неї, не під шапку`, vis && vis.top >= vis.headBottom - 2 && vis.top < vis.headBottom + 160, JSON.stringify(vis));
  }
  const cov = await lastNotCovered(page, '.svc'); ok(`[${tag}] остання послуга не під нижньою панеллю`, cov.ok, cov.why);
  await shot(page, `${tag}-06-hair-bottom`);

  // пошук
  if (hasSearch) {
    const search = async (term) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.fill('#q', term); await pause(250); return page.$$eval('.svc .n', e => e.map(x => x.textContent)); };
    let r = await search('стриж'); ok(`[${tag}] пошук «стриж» → стрижки з усіх груп`, r.length >= 10 && r.every(n => /стриж/i.test(n)), r.length + ' шт.');
    ok(`[${tag}] пошук «стриж»: першими — самі стрижки`, r.length && /^стриж/i.test(r[0]), r[0]);
    await shot(page, `${tag}-07-search-strizh`);
    r = await search('СТРИЖКА ЧОЛ'); ok(`[${tag}] без урахування регістру, кілька слів`, r.length === 1 && /чоловіча/.test(r[0]), r.join(' | '));
    r = await search('маникюр'); ok(`[${tag}] рос. «маникюр» → манікюр з «Нігті» (пошук по всіх категоріях)`, r.length >= 5 && r.every(n => /манікюр/i.test(n)), r.length + ' шт.');
    r = await search('ногти'); ok(`[${tag}] рос. «ногти» → нігті`, r.length >= 3, r.length + ' шт.');
    r = await search('окрашивание'); ok(`[${tag}] рос. «окрашивание» → фарбування`, r.length >= 10, r.length + ' шт.');
    r = await search('брів'); ok(`[${tag}] «брів» → фарбування брів`, r.some(n => /брів/i.test(n)), r.join(' | '));
    r = await search('кончиков'); ok(`[${tag}] рос. «кончиков» → стрижка кінчиків`, r.length >= 3, r.length + ' шт.');
    a = await layoutAudit(page); ok(`[${tag}] результати пошуку: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
    r = await search('zzqxw'); const empty = await page.$('#nothing');
    ok(`[${tag}] «нічого не знайдено» з порадою`, r.length === 0 && !!empty && /нічого не знайдено/i.test(await empty.textContent()));
    await shot(page, `${tag}-08-search-empty`);
    await page.fill('#q', ''); await pause(200);
    ok(`[${tag}] очищення пошуку повертає категорію`, (await page.$$eval('.svc', e => e.length)) === nSvc);
  }
  // назад → категорії
  await page.click('.head .back'); await page.waitForSelector('.row');
  ok(`[${tag}] «←» з послуг повертає до категорій`, (await catNames(page)).length >= 2);
  // пошук прямо з екрана категорій
  if (await page.$('#q')) {
    await page.fill('#q', 'педикюр гель'); await pause(250);
    const r = await page.$$eval('.svc .n', e => e.map(x => x.textContent));
    ok(`[${tag}] пошук з екрана категорій (по всіх)`, r.length >= 2 && r.every(n => /педикюр/i.test(n) && /гель/i.test(n)), r.join(' | '));
    await shot(page, `${tag}-09-search-from-cats`);
  }
  await page.context().close();
}

// ── 1б. Шторка «Ваш номер» при першому відкритті не перехоплює тап «Записатися» ──
async function phoneAskPass(init, user) {
  const page = await openApp(init, user, { askPhone: true, prodCat: true });
  await page.click('#go-book'); await pause(1200);
  await shot(page, '390x844-dark-00-first-open-tap');
  const sheet = !!(await page.$('.sheet'));
  ok('перший запуск: тап «Записатися» одразу веде до категорій, шторка номера не вистрибує поверх', !sheet && (await catNames(page)).length >= 2, sheet ? 'шторка поверх' : '');
  await page.context().close();
}

// ── 2. Повільна мережа ──
async function slowPass(init, user) {
  const page = await openApp(init, user, { slowCatalog: 2500, prodCat: true });
  await page.click('#go-book'); await pause(400);
  const spin = !!(await page.$('.spin')); await shot(page, '390x844-dark-10-slow-network');
  ok('повільна мережа: видно індикатор завантаження', spin);
  await page.waitForSelector('.row', { timeout: 8000 });
  ok('повільна мережа: категорії зʼявились', (await catNames(page)).length >= 2);
  await page.context().close();
}

// ── 3. Повний шлях запису на QA (без підміни каталогу) ──
async function setupFixture(init) {
  const cat = await api(init, 'GET', '/catalog');
  const svcs = cat.body.categories.flatMap(c => c.services.map(s => ({ ...s, cat: c.name }))).filter(s => +s.duration_min >= 30 && +s.duration_min <= 90);
  for (const s of svcs) {
    const m = ((await api(init, 'GET', '/masters?service=' + s.id)).body.masters || [])[0]; if (!m) continue;
    const d0 = (await q(`SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date + 2)::text d`))[0].d;
    if ((await q(`SELECT 1 FROM master_schedule_days WHERE master_id=$1 AND work_date BETWEEN $2::date AND $2::date + 3`, [m.id, d0])).length) continue;
    await q(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, tenant_id, source)
             SELECT $1, $2::date + i, '10:00', '18:00', $3, $4 FROM generate_series(0,2) i`, [m.id, d0, TENANT, FIX_SRC]);
    const slots = (await api(init, 'GET', `/slots?service=${s.id}&master=${m.id}&date=${d0}`)).body.slots || [];
    if (slots.length < 4) continue;
    return { svc: s, master: m, date: d0, slots };
  }
  throw new Error('немає послуги з вільним майстром для фікстури');
}

async function flowPass(vw, vh, theme) {
  const tag = `${vw}x${vh}-${theme}-flow`;
  const U = mkUser('Олена'); const init = initFor(U);
  const P = await setupFixture(init);
  console.log(`фікстура: ${P.svc.name} [${P.svc.cat}] / ${P.master.name} / ${P.date}`);
  const page = await openApp(init, U, { vw, vh, theme });
  await page.click('#go-book'); await page.waitForSelector('.row');
  // знайти послугу пошуком (як клієнт: перше слово назви)
  if (await page.$('#q')) {
    const word = P.svc.name.split(/\s+/).find(w => w.length >= 4) || P.svc.name;
    await page.fill('#q', word.toLowerCase()); await pause(250);
    await shot(page, `${tag}-1-search`);
  } else {
    await page.locator('.row', { hasText: P.svc.cat }).first().click(); await page.waitForSelector('.svc');
  }
  const svcBtn = page.locator('.svc', { hasText: P.svc.name }).first();
  await svcBtn.scrollIntoViewIfNeeded();
  // подвійний тап по послузі → один крок уперед
  await svcBtn.dblclick();
  await page.waitForSelector(`.mst[data-id="${P.master.id}"]`);
  await shot(page, `${tag}-2-master`);
  let a = await layoutAudit(page); ok(`[${tag}] майстри: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
  await page.click('.head .back'); await page.waitForSelector('.svc');
  ok(`[${tag}] подвійний тап по послузі не дублює крок (← одразу до послуг, пошук збережено)`,
    !(await page.$('.mst')) && (!(await page.$('#q')) || (await page.inputValue('#q')).length > 0));
  await page.locator('.svc', { hasText: P.svc.name }).first().click();
  await page.waitForSelector(`.mst[data-id="${P.master.id}"]`); await page.click(`.mst[data-id="${P.master.id}"]`);
  await page.click('#next-master'); await page.waitForSelector('.day');
  if (!(await page.$(`.day[data-date="${P.date}"]`))) await page.click('[aria-label="Наступний тиждень"]');
  await page.click(`.day[data-date="${P.date}"]`);
  const slot = P.slots[0].start_min;
  await page.waitForSelector(`.slot[data-min="${slot}"]`); await page.click(`.slot[data-min="${slot}"]`);
  await shot(page, `${tag}-3-time`);
  a = await layoutAudit(page); ok(`[${tag}] дата/час: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
  let cov = await lastNotCovered(page, '.slot'); ok(`[${tag}] останній слот не під кнопкою «Далі»`, cov.ok, cov.why);
  await page.click('#next-time'); await page.waitForSelector('#confirm-btn');
  await shot(page, `${tag}-4-confirm`);
  a = await layoutAudit(page); ok(`[${tag}] підтвердження: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
  const cf = await page.textContent('.cf'); ok(`[${tag}] підтвердження: назва, майстер, ціна, тривалість`, cf.includes(P.svc.name) && cf.includes(P.master.name) && /грн|прайсом/.test(cf) && /хв|год/.test(cf));
  await page.evaluate(() => { const b = document.getElementById('confirm-btn'); b.click(); b.click(); });
  await page.waitForSelector('#phone-in'); await shot(page, `${tag}-5-phone`);
  await page.fill('#phone-in', '+38099' + String(1000000 + Math.floor(Math.random() * 8999999)));
  await page.click('#save-phone'); await page.waitForSelector('#to-cabinet', { timeout: 15000 });
  await shot(page, `${tag}-6-done`);
  const c = (await q(`SELECT id FROM clients WHERE telegram_id=$1`, [U.id]))[0];
  const ap = await q(`SELECT id FROM appointments WHERE client_id=$1 AND status <> 'cancelled'`, [c.id]);
  ok(`[${tag}] подвійний тап «Підтвердити» = 1 запис у QA-базі`, ap.length === 1, 'записів ' + ap.length);
  await page.click('#to-cabinet'); await page.waitForSelector('.ap');
  await shot(page, `${tag}-7-cabinet`);
  a = await layoutAudit(page); ok(`[${tag}] кабінет: нічого не обрізано`, !a.issues.length, a.issues.join('; '));
  // перенос: на 2 год пізніше
  await page.click('.ap .mv'); await page.waitForSelector('.banner');
  await page.waitForSelector('.slot', { timeout: 10000 }).catch(() => {});
  const s2 = P.slots.find(s => s.start_min >= slot + 120) || P.slots[P.slots.length - 1];
  if (!(await page.$(`.day[data-date="${P.date}"].sel`))) { if (!(await page.$(`.day[data-date="${P.date}"]`))) await page.click('[aria-label="Наступний тиждень"]'); await page.click(`.day[data-date="${P.date}"]`); }
  await page.waitForSelector(`.slot[data-min="${s2.start_min}"]`); await page.click(`.slot[data-min="${s2.start_min}"]`);
  await shot(page, `${tag}-8-move-time`);
  await page.click('#next-time'); await page.waitForSelector('#confirm-btn'); await page.click('#confirm-btn');
  await page.waitForSelector('#to-cabinet', { timeout: 15000 });
  const ap2 = await q(`SELECT starts_at FROM appointments WHERE client_id=$1 AND status <> 'cancelled'`, [c.id]);
  ok(`[${tag}] перенос: 1 активний запис`, ap2.length === 1);
  await page.click('#to-cabinet'); await page.waitForSelector('.ap');
  await page.click('.ap .x'); await page.waitForSelector('#app .empty', { timeout: 10000 });
  await shot(page, `${tag}-9-cancelled-empty`);
  const ap3 = await q(`SELECT 1 FROM appointments WHERE client_id=$1 AND status <> 'cancelled'`, [c.id]);
  ok(`[${tag}] скасування: активних записів 0, порожній стан показано`, ap3.length === 0);
  // назад з кабінету → головна
  await page.click('.head .back'); await page.waitForSelector('#go-book');
  ok(`[${tag}] «←» з кабінету → головна`, true);
  await page.context().close();
}

// Режим майстра: тимчасово привʼязуємо QA-майстра до тестового tg id (QA-база), після — повертаємо як було.
const savedMaster = [];
async function masterPass() {
  const M = (await q(`SELECT u.id AS uid, u.master_id, m.name FROM users u JOIN roles r ON r.id=u.role_id JOIN masters m ON m.id=u.master_id
     WHERE r.code='master' AND u.is_active AND u.merged_into IS NULL AND u.telegram_id IS NULL AND m.active ORDER BY u.id LIMIT 1`))[0];
  if (!M) return ok('режим майстра: у QA є майстер з обліковкою', false);
  const U = mkUser(M.name.split(' ')[0]);
  savedMaster.push({ uid: M.uid, mid: M.master_id, mtg: (await q(`SELECT telegram_id FROM masters WHERE id=$1`, [M.master_id]))[0].telegram_id });
  await q(`UPDATE users SET telegram_id=$1 WHERE id=$2`, [U.id, M.uid]);
  for (const [sh, nm] of [["now()+interval '10 minutes'", 'Олександра-Вікторія Довгопрізвищна (QA)'], ["now()+interval '1 day'", 'Ірина (QA)']])
    await q(`INSERT INTO appointments (tenant_id, master_id, client_name, status, starts_at, ends_at, price, source)
      VALUES ($1,$2,$3,'booked', ${sh}, ${sh}+interval '1 hour', 1450, $4)`, [TENANT, M.master_id, nm, FIX_SRC]);
  for (const [vw, vh, th] of [[390, 844, 'dark'], [360, 740, 'light']]) {
    const tag = `[${vw}x${vh}-${th}] майстер`;
    const page = await openApp(initFor(U), U, { vw, vh, theme: th });
    await page.waitForSelector('#mode-master', { timeout: 8000 }).catch(() => {});
    const sw = await page.$('#mode-master');
    ok(`${tag}: перемикач «Я майстер» є`, sw);
    if (!sw) { await page.context().close(); continue; }
    await page.click('#mode-master');
    await page.waitForSelector('#k-earned', { timeout: 10000 }).catch(() => {});
    await pause(400);
    await page.screenshot({ path: path.join(OUT, `${vw}x${vh}-${th}-40-master.png`), fullPage: true });
    const a = await layoutAudit(page);
    ok(`${tag}: кабінет без обрізань/виходу за край`, !a.issues.length, a.issues.join(' | '));
    const today = await page.$$eval('#mtoday .row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    ok(`${tag}: «Клієнти сьогодні» показує запис з довгим імʼям`, today.some(t => /Довгопрізвищна/.test(t)), today.join(' / '));
    await page.click('#mode-client').catch(() => {});
    await pause(300);
    ok(`${tag}: назад у режим клієнта`, await page.$('#go-book'));
    await page.context().close();
  }
}

async function cleanup() {
  if (!db) return;
  const cl = await q(`SELECT id FROM clients WHERE telegram_id = ANY($1::bigint[])`, [uids]);
  const ids = cl.map(r => r.id);
  if (ids.length) {
    const aps = (await q(`SELECT id FROM appointments WHERE client_id = ANY($1::int[])`, [ids])).map(r => r.id);
    if (aps.length) {
      for (const t of ['online_bookings', 'booking_reminders', 'notification_log']) await q(`DELETE FROM ${t} WHERE appointment_id = ANY($1::int[])`, [aps]).catch(() => {});
      await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [aps]).catch(e => console.error('cleanup appts:', e.message));
    }
    await q(`DELETE FROM clients WHERE id = ANY($1::int[])`, [ids]).catch(e => console.error('cleanup clients:', e.message));
  }
  await q(`DELETE FROM master_schedule_days WHERE source=$1`, [FIX_SRC]).catch(() => {});
  await q(`DELETE FROM appointments WHERE source=$1`, [FIX_SRC]).catch(() => {});
  for (const m of savedMaster) {
    await q(`UPDATE users SET telegram_id=NULL WHERE id=$1`, [m.uid]).catch(e => console.error('restore user:', e.message));
    await q(`UPDATE masters SET telegram_id=$2 WHERE id=$1`, [m.mid, m.mtg]).catch(e => console.error('restore master:', e.message));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!process.env.QA_DB_URL || process.env.QA_DB_URL === process.env.DATABASE_URL) throw new Error('QA_DB_URL порожній або = DATABASE_URL — стоп');
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  browser = await chromium.launch();
  let fatal = null;
  try {
    const V = mkUser('Марія'); const initV = initFor(V);
    for (const [vw, vh] of [[390, 844], [360, 740]]) for (const th of ['dark', 'light']) {
      try { await displayPass(initV, V, vw, vh, th); } catch (e) { ok(`[${vw}x${vh}-${th}] прохід відображення без збоїв`, false, e.message.split('\n').slice(0,6).join(' ¦ ')); }
    }
    const I = mkUser('Іра'); await phoneAskPass(initFor(I), I).catch(e => ok('шторка номера без збоїв', false, e.message.split('\n').slice(0,4).join(' ¦ ')));
    if (process.env.VIS_ONLY !== 'display') {
      await slowPass(initV, V).catch(e => ok('повільна мережа без збоїв', false, e.message.split('\n').slice(0,6).join(' ¦ ')));
      for (const [vw, vh, th] of [[390, 844, 'dark'], [360, 740, 'light']]) {
        try { await flowPass(vw, vh, th); } catch (e) { ok(`[${vw}x${vh}-${th}] шлях запису без збоїв`, false, e.message.split('\n').slice(0,6).join(' ¦ ')); }
      }
      await masterPass().catch(e => ok('режим майстра без збоїв', false, e.message.split('\n').slice(0,6).join(' ¦ ')));
    }
  } catch (e) { fatal = e; console.error(e); }
  finally {
    await browser.close().catch(() => {});
    await cleanup().catch(e => console.error('cleanup:', e.message));
    S.stop(); await db.end().catch(() => {});
  }
  const fail = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\nПІДСУМОК ${TAG}: ${results.length - fail.length}/${results.length} ✔` + (fail.length ? `, ✘ ${fail.length}` : ''));
  process.exit(fatal || fail.length ? 1 : 0);
})();
