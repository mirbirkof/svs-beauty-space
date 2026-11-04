// УСТАРЕЛО з combo-0411 (04.11): кнопок #next-master/#next-time більше немає — послуга → одразу час, тап на слот → підтвердження. Актуальний прохід: test/_miniapp-combo-0411.js
'use strict';
// price-materials-0411: Playwright-мок мініапу. app.html — з файлу (не з проду), API — мок, каталог — знімок живого (fixtures-hair-catalog-0411.json).
// Запуск: node test/_miniapp-hair-prices-0411.js  → скріни у reports/hair-prices-0411/, вихід 1 при провалі перевірки.
const fs = require('fs'), path = require('path');
const { chromium } = require('/home/client/workspace/node_modules/playwright/index.js');
const APP = path.join(__dirname, '../public/app.html');
const OUT = path.join(__dirname, '../../reports/hair-prices-0411');
const CAT = require('./fixtures-hair-catalog-0411.json');
const BASE = process.env.MINIAPP_BASE || 'http://127.0.0.1:3011';
fs.mkdirSync(OUT, { recursive: true });
const fails = []; const ok = (c, m) => { console.log((c ? '✔ ' : '✘ ') + m); if (!c) fails.push(m); };
const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
const days = Array.from({ length: 14 }, (_, i) => ({ date: iso(new Date(today.getTime() + i * 864e5)), count: i ? 5 : 0 }));
let lastBook = null;

async function run(b, name, steps) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', e => ok(false, `${name}: JS-помилка ${e.message}`));
  await p.route('**/telegram-web-app.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await p.route('**/p/app.html*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP, 'utf8') }));
  await p.route('**/api/miniapp/**', r => {
    const u = r.request().url();
    if (u.includes('/catalog')) return r.fulfill({ json: { categories: CAT } });
    if (u.includes('/me')) return r.fulfill({ json: { client: { name: 'Олена', has_phone: true }, master: { is_master: false } } });
    if (u.includes('/masters')) return r.fulfill({ json: { masters: [{ id: 7, name: 'Анна', specialty: 'Перукар-стиліст', rating: 4.9, reviews: 31 }] } });
    if (u.includes('/days')) return r.fulfill({ json: { today: iso(today), days } });
    if (u.includes('/slots')) return r.fulfill({ json: { slots: [{ start_min: 600 }, { start_min: 720 }, { start_min: 840 }] } });
    if (u.includes('/book')) {
      const body = JSON.parse(r.request().postData() || '{}'); lastBook = body;
      const est = body.length_unknown ? '≈ 3 000–6 000 ₴ (довжину визначить майстер)' : body.variant_id ? '≈ 3 000 ₴ = робота 2 400 + матеріал 600' : null;
      return r.fulfill({ json: { ok: true, booking: { service: 'Послуга', master: 'Анна', date_label: 'завтра', time: '10:00', duration: '2 год', price: 750, estimate_text: est, price_note: est ? 'робота + матеріал' : null } } });
    }
    return r.fulfill({ json: {} });
  });
  await p.addInitScript(() => {
    const noop = () => {};
    const base = { initData: 'qa', initDataUnsafe: { user: { id: 1, first_name: 'Олена' } }, version: '8.0', platform: 'android', colorScheme: 'light', themeParams: {},
      isVersionAtLeast: () => true, checkHomeScreenStatus: (cb) => cb('added'), HapticFeedback: { selectionChanged: noop, notificationOccurred: noop, impactOccurred: noop } };
    const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[A-Z]/.test(k) ? mk({}) : noop)) });
    window.Telegram = { WebApp: mk(base) };
    try { localStorage.setItem('hs_offer', '1'); } catch (e) {}
  });
  await p.goto(BASE + '/p/app.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  const shot = async (n) => {
    const w = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    ok(w[0] <= w[1], `${name}/${n}: без горизонтального скролу (${w[0]}<=${w[1]})`);
    await p.screenshot({ path: path.join(OUT, `${name}-${n}.png`) });
  };
  try { await steps(p, shot); } catch (e) { ok(false, `${name}: ${e.message.split('\n')[0]}`); await p.screenshot({ path: path.join(OUT, `${name}-ERR.png`) }); }
  await ctx.close();
}
const tap = async (p, sel, n = 0) => { await p.locator(sel).nth(n).click(); await p.waitForTimeout(350); };
const toConfirm = async (p, shot) => {
  await tap(p, '.mst'); await tap(p, '#next-master'); await p.waitForSelector('.slot');
  await tap(p, '.slot'); await shot('3-time'); await tap(p, '#next-time');
};

(async () => {
  const b = await chromium.launch();
  // 1. Біовирівнювання: картка «від» → чіпи довжини → «до 25 см» → підтвердження → готово
  await run(b, 'bio', async (p, shot) => {
    await tap(p, '#go-book'); await p.waitForSelector('.row.cat'); await tap(p, '.row.cat:has-text("Волосся")');
    const card = p.locator('.svc:has-text("Біовирівнювання")').first();
    await card.scrollIntoViewIfNeeded(); const ct = await card.innerText();
    ok(/від\s*3[\s ]?000/.test(ct) && /робота \+ матеріал/.test(ct), 'bio: картка «від 3 000 ₴ · робота + матеріал» → ' + ct.replace(/\s+/g, ' '));
    await shot('1-card'); await card.click(); await p.waitForTimeout(400);
    ok(await p.locator('.lt').count() >= 5, 'bio: екран довжини, плиток ' + await p.locator('.lt').count());
    await tap(p, '.lt:not(.unk)'); const s1 = await p.locator('#len-sum').innerText();
    ok(/3[\s ]?000/.test(s1) && /2[\s ]?400/.test(s1) && /600/.test(s1), 'bio: сума чіпа «≈ 3 000 = 2 400 + 600» → ' + s1.replace(/\s+/g, ' '));
    await shot('2a-length-25'); await tap(p, '.lt.unk'); const s2 = await p.locator('#len-sum').innerText();
    ok(/3[\s ]?000.*6[\s ]?000/.test(s2.replace(/\s+/g, ' ')), 'bio: «Не знаю» → діапазон ' + s2.replace(/\s+/g, ' '));
    await shot('2b-length-unknown'); await tap(p, '.lt:not(.unk)'); await tap(p, '#next-length');
    await toConfirm(p, shot); const cf = await p.locator('.cf').innerText();
    ok(/робота 2[\s ]?400/.test(cf) && /матеріал 600/.test(cf) && /Орієнтовно/.test(cf), 'bio: підтвердження з розкладом і «Орієнтовно» → ' + cf.replace(/\s+/g, ' ').slice(0, 160));
    await shot('4-confirm'); await tap(p, '#confirm-btn'); await p.waitForSelector('.okic');
    ok(lastBook && lastBook.variant_id > 0 && !lastBook.length_unknown, 'bio: /book отримав variant_id=' + (lastBook && lastBook.variant_id));
    ok(/≈ 3 000 ₴ = робота 2 400 \+ матеріал 600/.test(await p.locator('.cf').innerText()), 'bio: «Ви записані» з оцінкою');
    await shot('5-done');
  });
  // 1б. «Не знаю» до кінця: у /book летить length_unknown
  await run(b, 'bio-unknown', async (p, shot) => {
    await tap(p, '#go-book'); await p.waitForSelector('.row.cat'); await tap(p, '.row.cat:has-text("Волосся")');
    await p.locator('.svc:has-text("Біовирівнювання")').first().click(); await p.waitForTimeout(400);
    await tap(p, '.lt.unk'); await tap(p, '#next-length'); await toConfirm(p, shot);
    await shot('4-confirm'); await tap(p, '#confirm-btn'); await p.waitForSelector('.okic');
    ok(lastBook && lastBook.length_unknown === true && lastBook.variant_id > 0, 'bio-unknown: /book length_unknown=true');
    await shot('5-done');
  });
  // 2. Стрижка жіноча: 2 варіанти (без матеріалу) → екран довжини без «+ матеріал»
  await run(b, 'cut', async (p, shot) => {
    await tap(p, '#go-book'); await p.waitForSelector('.row.cat'); await tap(p, '.row.cat:has-text("Волосся")');
    const card = p.locator('.svc:has-text("Стрижка жіноча")').first(); await card.scrollIntoViewIfNeeded();
    const ct = await card.innerText(); ok(/від\s*750/.test(ct) && !/матеріал/.test(ct), 'cut: картка «від 750 ₴» без матеріалу → ' + ct.replace(/\s+/g, ' '));
    await shot('1-card'); await card.click(); await p.waitForTimeout(400);
    ok(await p.locator('.lt').count() >= 2, 'cut: екран довжини'); await tap(p, '.lt:not(.unk)'); await shot('2-length');
    await tap(p, '#next-length'); await toConfirm(p, shot); await shot('4-confirm');
    await tap(p, '#confirm-btn'); await p.waitForSelector('.okic'); await shot('5-done');
  });
  // 3. Манікюр: звичайна послуга — одразу до майстра, без кроку довжини
  await run(b, 'mani', async (p, shot) => {
    await tap(p, '#go-book'); await p.waitForSelector('.row.cat'); await tap(p, '.row.cat:has-text("Нігті")');
    const card = p.locator('.svc:has-text("анікюр")').first(); await card.scrollIntoViewIfNeeded(); await shot('1-card');
    await card.click(); await p.waitForTimeout(400);
    ok(await p.locator('.lt').count() === 0 && await p.locator('#next-master').count() === 1, 'mani: одразу екран майстра (без довжини)');
    await toConfirm(p, shot); const cf = await p.locator('.cf').innerText();
    ok(/₴/.test(cf) && !/Орієнтовно/.test(cf), 'mani: підтвердження з ціною без «Орієнтовно»');
    await shot('4-confirm'); await tap(p, '#confirm-btn'); await p.waitForSelector('.okic');
    ok(lastBook && !lastBook.variant_id, 'mani: /book без variant_id'); await shot('5-done');
  });
  await b.close();
  console.log(fails.length ? `ПРОВАЛ: ${fails.length}` : 'ВСЕ ✔');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
