// Браузерний e2e «комплекс + менше натискань» (Босс 04.11): Chromium 390×844, підписаний initData, ЛИШЕ QA-база.
// Запуск: node test/_miniapp-combo-0411.js  (не входить у щит: префікс «_»).
// Міряє тапи ДО (стара app.html з git) і ПІСЛЯ (нова), бронює комплекс в одного майстра і ланцюжком у різних,
// перевіряє, що записи йдуть підряд без розриву, і екран «графік ще складається».
// Скріншоти → ../reports/miniapp-combo-0411/. Усе створене (клієнти 77xxxxxxxx, записи, графік qa-combo-0411) прибирається.
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startQaServer } = require('./_qa-server');
const { sign } = require('../lib/tg-initdata');

const PORT = 3071;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'reports', 'miniapp-combo-0411');
const BOT = '7000000001:QA-' + crypto.randomBytes(10).toString('hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const FIX_SRC = 'qa-combo-0411';
// стара версія екрана — для чесного «ДО» (коміт до правок combo-0411)
const OLD_REF = process.env.OLD_APP_REF || '74530aa1^'; // батько коміту combo-0411 = екран ДО змін
const now = () => Math.floor(Date.now() / 1000);
const uids = [];
const mkUser = (n) => { const id = 7700000000 + Math.floor(Math.random() * 99999999); uids.push(id); return { id, first_name: n, username: 'qa_combo_' + id }; };
const initFor = (u) => sign({ auth_date: now(), query_id: 'AAc' + u.id, user: u }, BOT);
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); };
const phone = () => '+38099' + String(1000000 + Math.floor(Math.random() * 8999999));
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

let db, S, browser;
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function api(init, method, url, body) {
  const r = await fetch(BASE + '/api/miniapp' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const stub = (init, user) => `window.__tg={expand:0,ready:0};
window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{user:${JSON.stringify(user)}},platform:'unknown',colorScheme:'dark',
themeParams:{bg_color:'#141012',text_color:'#f4ece6'},version:'7.10',
ready(){__tg.ready++},expand(){__tg.expand++},setHeaderColor(){},setBackgroundColor(){},
BackButton:{isVisible:false,show(){this.isVisible=true},hide(){this.isVisible=false},onClick(){}},
MainButton:{show(){},hide(){},setText(){},onClick(){}},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
showConfirm(m,cb){cb(true)},close(){}}};`;

async function openApp(init, user, html) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'uk-UA' });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', r => r.fulfill({ contentType: 'application/javascript', body: stub(init, user) }));
  if (html) await ctx.route(BASE + '/p/app.html*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const page = await ctx.newPage();
  page.__taps = 0;
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.goto(BASE + '/p/app.html');
  await page.waitForSelector('#go-book');
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
// кожен «тап клієнта» йде лише через цю функцію — так і рахуємо
async function tap(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  await loc.click(); page.__taps++;
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function scheduleFor(masterIds, d0) {
  for (const id of masterIds) {
    await q(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, tenant_id, source)
             SELECT $1, $2::date + i, '10:00', '19:00', $3, $4 FROM generate_series(0,2) i
             WHERE NOT EXISTS (SELECT 1 FROM master_schedule_days x WHERE x.master_id=$1 AND x.work_date=$2::date + i)`, [id, d0, TENANT, FIX_SRC]);
  }
}

// ── шлях клієнта до «Ви записані!», мінімум тапів; працює і на старій, і на новій версії ──
async function walkSingle(page, svc, tag) {
  await tap(page, '#go-book');
  await page.waitForSelector('.row');
  if (tag) await shot(page, tag + '-1-categories');
  await tap(page, page.locator('.row', { hasText: svc.cat }));
  await page.waitForSelector('.svc');
  await tap(page, page.locator('.svc', { hasText: svc.name }));
  // стара версія: окремий екран майстрів з кнопкою «Далі»
  const first = await Promise.race([
    page.waitForSelector('#next-master', { timeout: 15000 }).then(() => 'masters'),
    page.waitForSelector('.slot', { timeout: 15000 }).then(() => 'slots'),
  ]);
  if (first === 'masters') {
    if (tag) await shot(page, tag + '-2-masters');
    if (await page.locator('#next-master').isDisabled()) { await tap(page, '.mst'); }
    await tap(page, '#next-master');
    await page.waitForSelector('.day');
    // день: якщо слоти ще не показані — тап по першому дню з вільним часом
    const slotOrDay = await Promise.race([
      page.waitForSelector('.slot', { timeout: 6000 }).then(() => 'slot'),
      pause(6000).then(() => 'none'),
    ]);
    if (slotOrDay === 'none') { await tap(page, '.day:has(.dot)'); await page.waitForSelector('.slot'); }
  }
  if (tag) await shot(page, tag + '-3-time');
  await tap(page, '.slot');
  if (await page.$('#next-time')) { await tap(page, '#next-time'); }
  await page.waitForSelector('#confirm-btn');
  if (tag) await shot(page, tag + '-4-confirm');
  await tap(page, '#confirm-btn');
  await page.waitForSelector('#to-cabinet', { timeout: 15000 });
  if (tag) await shot(page, tag + '-5-done');
  return page.__taps;
}

async function bookedOf(user) {
  return q(`SELECT a.id, a.master_id, a.service_id, a.status,
                   to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') d,
                   (extract(epoch FROM (a.starts_at AT TIME ZONE 'Europe/Kyiv')::time)/60)::int s,
                   (extract(epoch FROM (a.ends_at AT TIME ZONE 'Europe/Kyiv')::time)/60)::int e
            FROM appointments a JOIN clients c ON c.id=a.client_id
            WHERE c.telegram_id=$1 AND a.status<>'cancelled' ORDER BY a.starts_at, a.id`, [user.id]);
}
const backToBack = (rows) => rows.every((r, i) => i === 0 || r.s === rows[i - 1].e) && rows.every(r => r.d === rows[0].d);
const fmtRows = (rows) => rows.map(r => `#${r.master_id} svc${r.service_id} ${r.s}-${r.e}`).join(', ');

async function addTwo(p, a, b) {
  await tap(p, '#go-book'); await p.waitForSelector('.row');
  await tap(p, p.locator('.row', { hasText: a.cat })); await p.waitForSelector('.svc');
  await tap(p, p.locator('.svc', { hasText: a.name }));
  await p.waitForSelector('#add-more');
  await tap(p, '#add-more'); await p.waitForSelector('.row');
  await tap(p, p.locator('.row', { hasText: b.cat })); await p.waitForSelector('.svc');
  await tap(p, p.locator('.svc', { hasText: b.name }));
  await p.waitForSelector('.cartbox'); await p.waitForSelector('.slot', { timeout: 15000 });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!process.env.QA_DB_URL || process.env.QA_DB_URL === process.env.DATABASE_URL) throw new Error('QA_DB_URL порожній або збігається з DATABASE_URL — стоп');
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
  browser = await chromium.launch();
  const taps = {};
  try {
    const A = mkUser('Олена'); const initA = initFor(A);
    const d0 = (await q(`SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date + 2)::text d`))[0].d;
    const cat = (await api(initA, 'GET', '/catalog')).body;
    const plain = cat.categories.flatMap(c => c.services.filter(s => !(s.variants && s.variants.length) && +s.duration_min >= 30 && +s.duration_min <= 90).map(s => ({ ...s, cat: c.name })));
    const byId = new Map(plain.map(s => [s.id, s]));
    const links = await q(`SELECT ms.master_id, ms.service_id FROM master_services ms JOIN masters m ON m.id=ms.master_id
                           WHERE ms.active IS NOT FALSE AND m.online_booking_enabled IS TRUE AND ms.service_id = ANY($1::int[])`, [[...byId.keys()]]);
    const svcOf = new Map(); const mOf = new Map();
    for (const l of links) {
      if (!svcOf.has(l.master_id)) svcOf.set(l.master_id, []); svcOf.get(l.master_id).push(l.service_id);
      if (!mOf.has(l.service_id)) mOf.set(l.service_id, []); mOf.get(l.service_id).push(l.master_id);
    }

    // (e) послуга, у якої майстри є, але графіка немає — шукаємо ДО того, як вставимо фікстури
    let noSched = null;
    for (const s of plain) {
      const r = (await api(initA, 'GET', '/masters?service=' + s.id)).body || {};
      if (!(r.masters || []).length && Number(r.waiting) > 0) { noSched = { svc: s, waiting: mOf.get(s.id) || [] }; break; }
    }
    const waitingIds = noSched ? noSched.waiting : [];

    // (c) комплекс в одного майстра: 2 послуги однієї категорії, які робить той самий майстер
    let single = null;
    for (const [mid, sids] of svcOf) {
      if (waitingIds.includes(mid)) continue;
      const bycat = {}; for (const sid of sids) { const s = byId.get(sid); (bycat[s.cat] = bycat[s.cat] || []).push(s); }
      const pair = Object.values(bycat).find(a => a.length >= 2);
      if (pair) { single = { master: mid, a: pair[0], b: pair[1] }; break; }
    }
    // (d) ланцюжок: дві послуги різних категорій, жоден майстер не робить обидві
    let chain = null;
    outer: for (const a of plain) for (const b of plain) {
      if (a.cat === b.cat || a.id === b.id) continue;
      const ma = mOf.get(a.id) || [], mb = mOf.get(b.id) || [];
      if (!ma.length || !mb.length || ma.some(x => mb.includes(x))) continue;
      if ([...ma, ...mb].some(x => waitingIds.includes(x))) continue;
      chain = { a, b, ma, mb }; break outer;
    }
    if (!single || !chain) throw new Error('у QA немає послуг для фікстури: single=' + !!single + ' chain=' + !!chain);
    await scheduleFor([...new Set([...(mOf.get(single.a.id) || []), ...(mOf.get(single.b.id) || []), ...chain.ma, ...chain.mb])], d0);
    console.log(`фікстура ${d0}: один майстер #${single.master} «${single.a.name}» + «${single.b.name}»; ланцюжок «${chain.a.name}» (${chain.ma}) → «${chain.b.name}» (${chain.mb})`);

    // ── 1. Тапи ДО / ПІСЛЯ (клієнт уже з телефоном — як повторний візит) ──
    const oldHtml = execFileSync('git', ['show', OLD_REF + ':backend/public/app.html'], { cwd: path.join(__dirname, '..', '..') }).toString();
    ok('стара версія екрана взята з git для «ДО»', !/Додати ще послугу/.test(oldHtml) && /next-master/.test(oldHtml));
    const B1 = mkUser('Ірина'); const initB1 = initFor(B1);
    await api(initB1, 'POST', '/contact', { phone: phone(), name: 'Ірина QA' });
    let p = await openApp(initB1, B1, oldHtml);
    taps.before = await walkSingle(p, single.a, 'before');
    await p.context().close();
    const B2 = mkUser('Марта'); const initB2 = initFor(B2);
    await api(initB2, 'POST', '/contact', { phone: phone(), name: 'Марта QA' });
    p = await openApp(initB2, B2);
    taps.after = await walkSingle(p, single.a, 'after');
    await p.context().close();
    ok(`менше натискань: ДО ${taps.before} → ПІСЛЯ ${taps.after}`, taps.after < taps.before && taps.after <= 5);
    ok('обидва шляхи реально створили запис', (await bookedOf(B1)).length === 1 && (await bookedOf(B2)).length === 1);

    // ── 2. Комплекс в одного майстра через UI ──
    const C = mkUser('Оксана'); const initC = initFor(C);
    await api(initC, 'POST', '/contact', { phone: phone(), name: 'Оксана QA' });
    p = await openApp(initC, C);
    await addTwo(p, single.a, single.b);
    await shot(p, 'combo1-1-time');
    const cartTxt = oneLine(await p.locator('.cartbox').innerText());
    ok('кошик: обидві послуги + підсумок', cartTxt.includes(single.a.name) && cartTxt.includes(single.b.name) && /разом/i.test(cartTxt), cartTxt);
    await tap(p, '.slot'); await p.waitForSelector('#confirm-btn');
    await shot(p, 'combo1-2-confirm');
    await tap(p, '#confirm-btn'); await p.waitForSelector('#to-cabinet', { timeout: 15000 });
    await shot(p, 'combo1-3-done');
    taps.combo_one_master = p.__taps;
    await p.context().close();
    const rc = await bookedOf(C);
    ok('комплекс в одного майстра: обидві послуги, один майстер, підряд', rc.length >= 1 && new Set(rc.map(r => r.master_id)).size === 1 && backToBack(rc)
      && [single.a.id, single.b.id].every(id => rc.some(r => r.service_id === id)), fmtRows(rc));

    // ── 3. Ланцюжок у різних майстрів через UI ──
    const D = mkUser('Яна'); const initD = initFor(D);
    await api(initD, 'POST', '/contact', { phone: phone(), name: 'Яна QA' });
    const mi = (await api(initD, 'GET', `/masters?services=${chain.a.id},${chain.b.id}`)).body || {};
    ok('API: для пари без спільного майстра split=true', mi.split === true, JSON.stringify({ masters: (mi.masters || []).length, split: mi.split }));
    p = await openApp(initD, D);
    await addTwo(p, chain.a, chain.b);
    await shot(p, 'combo2-1-time');
    ok('чіп майстра: «підберемо (можна різних підряд)»', /різних підряд/.test(await p.locator('#master-chip').innerText()));
    await tap(p, '.slot'); await p.waitForSelector('#confirm-btn');
    const legsTxt = await p.locator('#legs').innerText().catch(() => '');
    await shot(p, 'combo2-2-confirm');
    const nLegs = await p.locator('#legs .l').count();
    ok('підтвердження показує хто і коли (2 рядки)', nLegs === 2, oneLine(legsTxt));
    await tap(p, '#confirm-btn'); await p.waitForSelector('#to-cabinet', { timeout: 15000 });
    await shot(p, 'combo2-3-done');
    taps.combo_chain = p.__taps;
    await p.context().close();
    const rd = await bookedOf(D);
    ok('ланцюжок: 2 записи у різних майстрів, другий одразу після першого', rd.length === 2 && rd[0].master_id !== rd[1].master_id && backToBack(rd)
      && chain.ma.includes(rd[0].master_id) && chain.mb.includes(rd[1].master_id), fmtRows(rd));
    const ob = await q(`SELECT count(*)::int n FROM online_bookings WHERE appointment_id = ANY($1::int[]) AND channel='miniapp'`, [rd.map(r => r.id)]);
    ok('обидва записи потрапили в онлайн-записи (канал miniapp)', ob[0].n === 2, 'n=' + ob[0].n);

    // той самий час комплексу іншим клієнтом → відмова і нічого не створено
    const E = mkUser('Віра'); const initE = initFor(E);
    await api(initE, 'POST', '/contact', { phone: phone(), name: 'Віра QA' });
    const legs = rd.map(r => ({ master_id: r.master_id, start_min: r.s }));
    const rr = await api(initE, 'POST', '/book', { service_ids: [chain.a.id, chain.b.id], master_id: 'any', date: rd[0].d, start_min: rd[0].s, legs });
    ok('той самий час комплексу вдруге → відмова, у клієнта 0 записів', rr.status >= 400 && (await bookedOf(E)).length === 0, `status=${rr.status} ${rr.body && rr.body.error}`);

    // ── 4. Немає графіка ──
    if (noSched) {
      const F = mkUser('Ліна'); const initF = initFor(F);
      p = await openApp(initF, F);
      await tap(p, '#go-book'); await p.waitForSelector('.row');
      await tap(p, p.locator('.row', { hasText: noSched.svc.cat })); await p.waitForSelector('.svc');
      await tap(p, p.locator('.svc', { hasText: noSched.svc.name }));
      await p.waitForSelector('#no-schedule', { timeout: 10000 }).catch(() => null);
      await shot(p, 'no-schedule');
      const t = oneLine(await p.locator('#no-schedule').innerText().catch(() => ''));
      ok('майстер без графіка: не глухий кут — пояснення + кнопка адміністратору', /графік/i.test(t) && !!(await p.$('#no-sched-admin')), t);
      await p.context().close();
    } else ok('майстер без графіка: у QA немає такої послуги (сценарій пропущено)', true, 'skip');
  } catch (e) {
    ok('сценарій без винятків', false, e.stack || e.message);
  } finally {
    await browser.close().catch(() => {});
    await q(`DELETE FROM master_schedule_days WHERE source=$1`, [FIX_SRC]).catch(e => console.error('cleanup sched', e.message));
    await q(`DELETE FROM master_services WHERE source=$1`, [FIX_SRC]).catch(e => console.error('cleanup ms', e.message));
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
    const leftS = (await q(`SELECT count(*)::int n FROM master_schedule_days WHERE source=$1`, [FIX_SRC]))[0].n;
    const leftM = (await q(`SELECT count(*)::int n FROM master_services WHERE source=$1`, [FIX_SRC]))[0].n;
    console.log('прибрано QA: клієнтів лишилось', left, '; рядків графіка фікстури', leftS, '; тимчасових привʼязок', leftM);
    const errs = S.log().split('\n').filter(l => /\[miniapp|booking-core|combo|Error/.test(l));
    if (errs.length) console.log('server log:\n' + errs.slice(-15).join('\n'));
    S.stop(); await db.end();
    const fail = results.filter(r => !r.pass).length;
    fs.writeFileSync(path.join(OUT, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), viewport: '390x844', taps, passed: results.length - fail, failed: fail, results }, null, 1));
    console.log('ТАПИ:', JSON.stringify(taps));
    console.log(`ПІДСУМОК: ${results.length - fail}/${results.length}`);
    process.exit(fail ? 1 : 0);
  }
})();
