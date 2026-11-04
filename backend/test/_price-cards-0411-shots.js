'use strict';
// price-cards-0411: скріни мініапу 390×844 «до/після». app.html — з файлу, API — мок, каталог — знімок живого /api/miniapp/catalog.
// Запуск: node test/_price-cards-0411-shots.js <catalog.json> <app.html> <префікс>  → reports/price-cards-0411/<префікс>-*.png
const fs = require('fs'), path = require('path');
const { chromium } = require('/home/client/workspace/node_modules/playwright/index.js');
const [CATF, APPF, PFX] = process.argv.slice(2);
const CAT = JSON.parse(fs.readFileSync(CATF, 'utf8'));
const APP = fs.readFileSync(APPF, 'utf8');
const OUT = path.join(__dirname, '../../reports/price-cards-0411');
const BASE = 'http://127.0.0.1:3011';
fs.mkdirSync(OUT, { recursive: true });
const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
const days = Array.from({ length: 14 }, (_, i) => ({ date: iso(new Date(today.getTime() + i * 864e5)), count: i ? 5 : 0 }));
const fails = []; const ok = (c, m) => { console.log((c ? '✔ ' : '✘ ') + m); if (!c) fails.push(m); };
const MASTERS = { 'Нігті': [{ id: 25, name: 'Кушнерук Тетяна', specialty: 'Топ-майстер' }, { id: 20, name: 'Анжела', specialty: 'Майстер манікюру' }] };
let curCat = '';
async function main() {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', e => ok(false, `JS-помилка ${e.message}`));
  await p.route('**/telegram-web-app.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await p.route('**/p/app.html*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: APP }));
  await p.route('**/api/miniapp/**', r => {
    const u = r.request().url();
    if (u.includes('/catalog')) return r.fulfill({ json: { categories: CAT } });
    if (u.includes('/me')) return r.fulfill({ json: { client: { name: 'Олена', has_phone: true }, master: { is_master: false } } });
    if (u.includes('/masters')) return r.fulfill({ json: { masters: MASTERS[curCat] || [{ id: 17, name: 'Інна', specialty: 'Майстер' }] } });
    if (u.includes('/days')) return r.fulfill({ json: { today: iso(today), days } });
    if (u.includes('/slots')) { const m = (MASTERS[curCat] || [{ id: 17, name: 'Інна' }])[0]; return r.fulfill({ json: { slots: [{ start_min: 600, master_id: m.id, master_name: m.name }, { start_min: 720, master_id: m.id, master_name: m.name }] } }); }
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
  const shot = async (n, full) => {
    const w = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    ok(w[0] <= w[1], `${PFX}/${n}: без горизонтального скролу`);
    await p.screenshot({ path: path.join(OUT, `${PFX}-${n}.png`), fullPage: !!full });
  };
  const home = async () => { await p.goto(BASE + '/p/app.html', { waitUntil: 'networkidle' }); await p.waitForTimeout(500); await p.click('#go-book'); await p.waitForSelector('.row.cat'); await p.waitForTimeout(300); };
  await home(); await shot('0-categories');
  for (const [i, c] of CAT.entries()) {
    curCat = c.name;
    await home();
    await p.locator('.row.cat').nth(i).click(); await p.waitForSelector('.svc'); await p.waitForTimeout(300);
    await shot(`${i + 1}-${c.name.replace(/\s+/g, '_')}`, true);
  }
  // окремі картки (якщо є): відкрити і зняти екран вибору
  const open = async (cat, re, tag) => {
    const ci = CAT.findIndex(c => c.name === cat); if (ci < 0) return;
    curCat = cat; await home(); await p.locator('.row.cat').nth(ci).click(); await p.waitForSelector('.svc');
    const btn = p.locator('.svc', { hasText: re }).first(); if (!(await btn.count())) { console.log('— немає картки', re); return; }
    await btn.scrollIntoViewIfNeeded(); await btn.click(); await p.waitForTimeout(500);
    await shot(tag + '-a');
    const t = p.locator('.lt').nth(1); if (await t.count()) { await t.click(); await p.waitForTimeout(250); await shot(tag + '-b'); }
    const nx = p.locator('#next-length'); if (await nx.count() && await nx.isEnabled()) { await nx.click(); await p.waitForTimeout(500); }
    const sl = p.locator('.slot').first(); if (await sl.count()) { await sl.click(); await p.waitForTimeout(500); await shot(tag + '-confirm'); }
  };
  await open('Волосся', /Мелірування|Мілірування/, 'h-mel');
  await open('Волосся', /Біовирівнювання/, 'h-bio');
  await open('Нігті', /Манікюр.*гель/i, 'n-gel');
  await open('Вії', /Нарощування вій/, 'l-ext');
  await open('Макіяж', /Макіяж/, 'm-mk');
  await b.close();
  console.log(fails.length ? `ПРОВАЛ ${fails.length}` : 'OK');
  process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
