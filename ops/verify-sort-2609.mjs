// [26.09 crm-sort-2609] Браузерна перевірка складу/інвентаризації на ПК 1280×800 (пісочниця :3037):
// порядок тонів Extremo/Socolor/Eterna за номером, регістр не рве групи, клік по заголовку ↑/↓, вибір живе після
// перезавантаження, Tab/Enter у «Факт» веде до наступного поля й зберігає, «спершу розбіжності», лічильник,
// поле «Факт» у видимій частині, подвійний клік «Внести» не проводить двічі.
// Запуск: node -r dotenv/config /tmp/qa-run.js ../ops/verify-sort-2609.mjs
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
import fs from 'node:fs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; let ok = 0, bad = 0;
const check = (cond, what) => { if (cond) { ok++; console.log('  ✓ ' + what); } else { bad++; console.log('  ✗ ' + what); } };
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('dialog', async d => { errs.push('DIALOG: ' + d.message().slice(0, 120)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
const S = (s) => s.split(/(\d+(?:\.\d+)?)/).filter(Boolean).map(x => /^\d/.test(x) ? +x : x.trim().toLowerCase());
const natAsc = (names) => names.every((n, i) => { if (!i) return true; const a = S(names[i - 1]), c = S(n);
  for (let k = 0; k < Math.min(a.length, c.length); k++) { if (a[k] === c[k]) continue; if (typeof a[k] === 'number' && typeof c[k] === 'number') return a[k] <= c[k]; return true; } return true; });
const salonNames = () => p.$$eval('#stListBody tr:not(.sv-grp) td:first-child > span', els => els.map(e => e.textContent.trim()));
const openStock = async () => { await p.evaluate(() => go('stock')); await p.waitForFunction(() => document.querySelectorAll('#stListBody tr').length > 5, null, { timeout: 60000 }); };

console.log('СКЛАД САЛОНУ');
await p.evaluate(() => localStorage.removeItem('svs_sv_sort_stock_salon'));
await openStock();
for (const series of ['extremo', 'socolor', 'eterna']) {
  await p.fill('#stListSearch', series); await p.waitForTimeout(500);
  const names = (await salonNames()).filter(n => new RegExp('^' + series + '\\s+[\\d.]+$', 'i').test(n.trim()));
  // у межах одного бренду тони йдуть за номером (групи брендів можуть мати свої підсписки)
  const grouped = await p.$$eval('#stListBody tr', trs => { const out = []; let g = ''; for (const tr of trs) { if (tr.classList.contains('sv-grp-b')) g = tr.textContent; else if (!tr.classList.contains('sv-grp')) { const s = tr.querySelector('td:first-child > span'); if (s) out.push([g, s.textContent.trim()]); } } return out; });
  const byG = {}; for (const [g, n] of grouped) if (new RegExp('^' + series + '\\s+[\\d.]+$', 'i').test(n)) (byG[g] = byG[g] || []).push(n);
  check(Object.values(byG).every(natAsc), `${series}: тони за номером (${names.slice(0, 8).join(', ')}…)`);
}
await p.fill('#stListSearch', 'socolor 9m'); await p.waitForTimeout(500);
const nine = (await salonNames()).map(s => s.toLowerCase().replace(/\s+/g, ' ').trim());
check(nine.length >= 2 && nine.every(x => x === 'socolor 9m'), `регістр/пробіли: «socolor 9m» і «SOCOLOR  9M» поруч (${nine.length} рядки)`);
await p.fill('#stListSearch', ''); await p.waitForTimeout(400);
const grpOk = async () => (await p.$$eval('#stListBody tr.sv-grp-t', e => e.length)) >= 1 && (await p.$eval('#stListBar .sv-info', e => e.textContent)).includes('згруповано');
check(await grpOk(), 'групи Тип → Бренд за замовчуванням');
const t0 = Date.now(); await p.evaluate(() => { const t = performance.now(); _stView.render(); window.__rt = Math.round(performance.now() - t); }); console.log('    (перемальовка списку: ' + await p.evaluate(() => window.__rt) + ' мс)');
await p.click('th[data-sv-sort="qty"]'); await p.waitForTimeout(400);
let qtys = await p.$$eval('#stListBody tr td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
check(qtys.every((v, i) => !i || qtys[i - 1] <= v), 'клік «Залишок» ↑ — за зростанням');
await p.click('th[data-sv-sort="qty"]'); await p.waitForTimeout(400);
qtys = await p.$$eval('#stListBody tr td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
check(qtys.every((v, i) => !i || qtys[i - 1] >= v), 'другий клік — за спаданням');
check((await p.$$eval('#stListBody tr.sv-grp', e => e.length)) === 0, 'при сортуванні колонкою — плоский список без груп');
await p.reload({ waitUntil: 'networkidle' }); await openStock();
qtys = await p.$$eval('#stListBody tr td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
check(qtys.every((v, i) => !i || qtys[i - 1] >= v) && await p.$eval('th[data-sv-sort="qty"]', th => th.classList.contains('sv-on') && th.textContent.includes('▼')), 'після перезавантаження вибір збережено (Залишок ↓)');
await p.fill('#stListSearch', 'extremo'); await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/sort-shots/after-4-salon-sorted.png' });
await p.fill('#stListSearch', ''); await p.waitForTimeout(300);
await p.click('th[data-sv-sort="qty"]'); await p.waitForTimeout(400);
check(await grpOk(), 'третій клік — назад до груп Тип → Бренд');
// чипи: Тип=Фарба + Бренд=Extremo
await p.click('.sv-types [data-v="Фарба"]'); await p.waitForTimeout(300);
await p.click('.sv-brands [data-v="Extremo"]'); await p.waitForTimeout(300);
const cnt = await p.$$eval('#stListBody tr:not(.sv-grp)', e => e.length);
const hdr = await p.$$eval('#stListBody tr.sv-grp', e => e.map(x => x.textContent.split(/\d/)[0].trim()));
check(cnt > 5 && hdr.join('|') === 'Фарба|Extremo', `чипи Фарба + Extremo: ${cnt} позицій, групи ${hdr.join(' / ')}`);
await p.click('.sv-stock [data-v="out"]'); await p.waitForTimeout(300);
const zeros = await p.$$eval('#stListBody tr:not(.sv-grp) td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
check(zeros.length > 0 && zeros.every(v => v <= 0), `«Немає» — лише нульові залишки (${zeros.length})`);
await p.click('.sv-stock [data-v=""]'); await p.click('.sv-types [data-v=""]'); await p.click('.sv-brands [data-v=""]');

// подвійний клік «Внести»
const vid = await p.evaluate(async () => (await api('/api/admin/stock/list?q=socolor')).items[0].id);
const movesBefore = await p.evaluate(async (v) => (await api('/api/admin/stock/movements?variant_id=' + v + '&limit=200')).items.length, vid);
await p.fill('#stockVariantId', String(vid)); await p.fill('#stockQty', '1'); await p.fill('#stockNote', 'qasort dblclick');
await p.dblclick('button[onclick^="addStock"]'); await p.waitForTimeout(2500);
const movesAfter = await p.evaluate(async (v) => (await api('/api/admin/stock/movements?variant_id=' + v + '&limit=200')).items.length, vid);
check(movesAfter - movesBefore === 1, `подвійний клік «Внести» — один рух (стало +${movesAfter - movesBefore})`);
await p.evaluate(async (v) => api('/api/admin/variants/' + v + '/stock', { method: 'POST', body: JSON.stringify({ qty: -1, note: 'qasort відкат' }) }), vid);

console.log('СКЛАД МАГАЗИНУ');
await p.evaluate(() => { localStorage.removeItem('svs_sv_sort_stock_store'); openEmbed('/admin/store.html', 'storefront Магазин'); });
await p.waitForTimeout(3000);
let fr = p.frames().find(f => f.url().includes('store.html'));
await fr.evaluate(() => showPane('stock')); await p.waitForTimeout(2000);
await fr.click('th[data-sv-sort="price"]'); await fr.click('th[data-sv-sort="price"]'); await p.waitForTimeout(300);
const pr = await fr.$$eval('#stockBody tr .sp-in[data-f="price"]', e => e.map(x => +x.value));
check(pr.length > 3 && pr.every((v, i) => !i || pr[i - 1] >= v), 'магазин: «Роздріб» ↓');
await p.evaluate(() => openEmbed('/admin/store.html', 'storefront Магазин')); await p.waitForTimeout(3000);
fr = p.frames().find(f => f.url().includes('store.html'));
await fr.evaluate(() => showPane('stock')); await p.waitForTimeout(2000);
check(await fr.$eval('th[data-sv-sort="price"]', th => th.classList.contains('sv-on') && th.textContent.includes('▼')), 'магазин: після перевідкриття вибір збережено');
await fr.click('th[data-sv-sort="price"]'); // скинути

console.log('АКТ ІНВЕНТАРИЗАЦІЇ САЛОНУ');
await p.evaluate(() => { localStorage.removeItem('svs_sv_sort_inv_salon'); openEmbed('/admin/crm-extra.html#inventory', 'fact_check Інвентаризація'); });
await p.waitForTimeout(4000);
fr = p.frames().find(f => f.url().includes('crm-extra.html'));
const aid = await fr.evaluate(async () => (await api('/api/inventory/audits', { method: 'POST', body: JSON.stringify({ scope: 'full', notes: 'qasort verify' }) })).audit_id);
try { const f = '/tmp/qasort-state.json'; const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.audits = [...new Set([...(s.audits || []), aid])]; fs.writeFileSync(f, JSON.stringify(s)); } catch (_) {}
await fr.evaluate(async (id) => { await loadInventory(); await openAudit(id); }, aid);
await p.waitForTimeout(2500);
await fr.fill('#inv-search', 'extremo'); await p.waitForTimeout(500);
const inputs = await fr.$$('#inv-items .inv-actual');
await inputs[0].click(); await inputs[0].fill('5'); await p.keyboard.press('Tab'); await p.waitForTimeout(1200);
let focus = await fr.evaluate(() => { const a = [...document.querySelectorAll('#inv-items .inv-actual')]; return a.indexOf(document.activeElement); });
check(focus === 1, 'Tab у «Факт» → наступне поле');
await p.keyboard.type('0'); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
focus = await fr.evaluate(() => { const a = [...document.querySelectorAll('#inv-items .inv-actual')]; return a.indexOf(document.activeElement); });
check(focus === 2, 'Enter → наступне поле');
const saved = await fr.evaluate(async (id) => (await api('/api/inventory/audits/' + id)).items.filter(x => x.actual_qty != null).length, aid);
check(saved === 2, `обидва факти збережено на сервері (${saved})`);
const counter = await fr.$eval('#inv-count', e => e.textContent);
check(/Пораховано 2 з \d+/.test(counter), 'лічильник: ' + counter.split('·')[0].trim());
// поле «Факт» у видимій частині після переходів
for (let i = 0; i < 8; i++) { await p.keyboard.press('Tab'); await p.waitForTimeout(150); }
const vis = await fr.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
check(vis, 'після 8 Tab поле «Факт» у видимій частині вікна');
await fr.click('button[onclick*="diffabs"]'); await p.waitForTimeout(400);
const firstDiff = await fr.$$eval('#inv-items tr .inv-delta', e => e.slice(0, 2).map(x => x.textContent.trim()));
check(firstDiff.every(x => x !== '—'), 'спершу розбіжності: зверху рядки з розбіжністю ' + firstDiff.join(', '));
await p.screenshot({ path: '/tmp/sort-shots/after-5-inventory-diff.png' });
await fr.click('th[data-sv-sort="diff"]'); await p.waitForTimeout(200); // скинути (перший клік з іншого ключа — ↑)
await fr.evaluate(() => INV_VIEW.setSort(null));

console.log('АКТ МАГАЗИНУ');
await p.evaluate(() => openEmbed('/admin/store.html', 'storefront Магазин')); await p.waitForTimeout(3000);
fr = p.frames().find(f => f.url().includes('store.html'));
const hadOpen = await fr.evaluate(async () => (await api('/api/store/inventory/acts')).items.some(a => a.status === 'open'));
if (hadOpen) console.log('  (у пісочниці вже є відкритий акт магазину — перевірку пропущено, чужий акт не чіпаю)');
else {
  await fr.evaluate(() => showPane('inv')); await p.waitForTimeout(1500);
  await fr.click('button[onclick="startInv()"]'); await p.waitForTimeout(3000);
  const f1 = await fr.$$('#invBody .inv-fact');
  await f1[0].click(); await f1[0].fill('1'); await p.keyboard.press('Tab'); await p.waitForTimeout(1500);
  const fi = await fr.evaluate(() => [...document.querySelectorAll('#invBody .inv-fact')].indexOf(document.activeElement));
  check(fi === 1, 'магазин: Tab у «Факт» → наступне поле');
  const cc = await fr.$eval('#invCounter', e => e.textContent);
  check(/Пораховано 1 з \d+/.test(cc), 'магазин: лічильник ' + cc.split('·')[0].trim());
  check(await fr.$$eval('#invBody tr.sv-grp-t', e => e.length) >= 1, 'магазин: групи Тип → Бренд в акті');
  await p.screenshot({ path: '/tmp/sort-shots/after-6-store-inv.png' });
  await fr.evaluate(async () => { const a = (await api('/api/store/inventory/acts')).items.find(x => x.status === 'open'); if (a) await api('/api/store/inventory/acts/' + a.id + '/cancel', { method: 'POST' }); });
}

console.log('ПОМИЛКИ СТОРІНОК:', errs.length ? errs.join(' | ') : 'немає');
console.log(`ПІДСУМОК: ${ok} ✓, ${bad} ✗`);
await b.close();
process.exit(bad ? 1 : 0);
