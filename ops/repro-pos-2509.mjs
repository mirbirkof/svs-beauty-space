// [25.09] жалоба: «поставила на прихід кондиціонер з ензимами журавлини, але в продажі його немає».
// Проверяем ВСЕ окна, что берут поиск /api/consumables/_variants, глазами браузера. ТОЛЬКО песочница :3037.
// Ничего не проводим: только открыть окно, набрать текст, посчитать строки.
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('response', r => { if (r.url().includes('/api/consumables') && r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 160)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
// фикстура как в проде: товар без филиала, остаток 1 через «прихід»; в конце — деактивация и 0
const FID = 'qa-kond-zhuravl-2509-' + Date.now().toString(36);
const fx = await p.evaluate(async (id) => {
  await api('/api/admin/products', { method: 'POST', body: JSON.stringify({ id, name: 'QA кондиціонер NA Golovy з ензимами журавлини 250мл', category_id: null }) });
  const v = (await api('/api/admin/products/' + id + '/variants', { method: 'POST', body: JSON.stringify({ volume: 'шт', price: 900, wholesale: 600, stock_qty: 0 }) })).variant;
  await api('/api/admin/variants/' + v.id + '/stock', { method: 'POST', body: JSON.stringify({ qty: 1, note: 'QA прихід' }) }).catch(e => ({ e: String(e) }));
  return v.id;
}, FID);
console.log('фикстура: вариант', fx);
let fail = 0;
const check = (name, ok, info) => { if (!ok) fail++; console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + ' — ' + info); };
const srv = (q) => p.evaluate(async (q) => (await api('/api/consumables/_variants?q=' + encodeURIComponent(q))).items || [], q);

// 1. окно «Оформити продаж»
await p.evaluate(() => posOpen());
const pos = async (q) => {
  await p.fill('#posQ', q); await p.waitForTimeout(1500);
  return p.evaluate(() => {
    const box = document.getElementById('posRes');
    const rows = [...box.querySelectorAll('div[onclick]')].map(d => d.dataset.nm || d.textContent);
    return { rows, scroll: getComputedStyle(box).overflowY, text: box.textContent };
  });
};
for (const q of ['кондиціонер', 'Кондиціонер журавл', 'журавлини кондиціонер', 'КОНДИЦІОНЕР']) {
  const all = await srv(q); const r = await pos(q);
  const want = Math.min(all.length, 50);
  const target = r.rows.findIndex(x => /QA кондиціонер NA Golovy/.test(x));
  check('Продаж «' + q + '»', r.rows.length === want && target >= 0,
    `сервер ${all.length}, на экране ${r.rows.length}, кондиционер с журавлиной на месте ${target}`);
}
// в наличии первыми
{ const all = await srv('кондиціонер'); const firstZero = all.findIndex(x => !(Number(x.stock_qty) > 0));
  const bad = firstZero >= 0 && all.slice(firstZero).some(x => Number(x.stock_qty) > 0);
  check('Порядок: в наличии первыми', !bad, `в наличии ${firstZero < 0 ? all.length : firstZero} из ${all.length}`); }
for (const q of ['100%', 'a_b', "o'reilly", '<script>', 'zzzнетакоготовара']) {
  const r = await pos(q); check('Продаж спецсимволы «' + q + '»', !errs.some(e => e.includes('HTTP')), `строк ${r.rows.length}, «${r.text.slice(0, 40)}»`);
}
{ const r = await pos('к'); check('Продаж 1 буква', r.rows.length === 0, 'пусто, как и раньше'); }
{ const r = await pos('кондиціонер'); check('Продаж: прокрутка списка', r.scroll === 'auto', 'overflow-y=' + r.scroll); }
// клик по товару кладёт его в корзину (ничего не проводим)
await p.fill('#posQ', 'кондиціонер журавл'); await p.waitForTimeout(1500);
const hasRow = await p.$('#posRes div[onclick]');
if (hasRow) { await hasRow.click(); const cart = await p.evaluate(() => document.querySelectorAll('#posCart tr').length);
  check('Продаж: клик добавляет в корзину', cart >= 1, 'позиций в корзине ' + cart); }
await p.evaluate(() => posClose());

// 2. материалы визита (окно в карточке записи) — рисуем его разметку и зовём ту же функцию
await p.evaluate(() => { const d = document.createElement('div'); d.id = 'tmpMat';
  d.innerHTML = '<input id="apptMatSearch"><div id="apptMatResults"></div>'; document.body.appendChild(d); });
await p.fill('#apptMatSearch', 'кондиціонер'); await p.evaluate(() => apptMatSearchRun(0)); await p.waitForTimeout(1500);
{ const all = await srv('кондиціонер'); const n = await p.evaluate(() => document.querySelectorAll('#apptMatResults [onclick]').length);
  check('Материалы визита «кондиціонер»', n === Math.min(all.length, 50), `сервер ${all.length}, на экране ${n}`); }
await p.evaluate(() => document.getElementById('tmpMat').remove());

// 3. расходники услуги
await p.evaluate(() => { if (!document.getElementById('consVarSearch')) { const d = document.createElement('div');
  d.innerHTML = '<input id="consVarSearch"><div id="consVarResults"></div>'; document.body.appendChild(d); } });
await p.evaluate(() => { document.getElementById('consVarSearch').value = 'кондиціонер журавл'; searchVars(); }); await p.waitForTimeout(1500);
{ const n = await p.evaluate(() => document.querySelectorAll('#consVarResults [onclick]').length);
  check('Расходники услуги «кондиціонер журавл»', n >= 1, 'на экране ' + n); }

// 4. операция в кассе: меню → «Каса магазину» (встроенное окно crm-extra)
await p.evaluate(() => openEmbed('/admin/crm-extra.html#cashbox', 'point_of_sale Каса магазину'));
await p.waitForTimeout(3000);
const fr = p.frames().find(f => f.url().includes('crm-extra.html'));
console.log('окно кассы:', fr ? fr.url().replace(BASE, '') : 'НЕ НАЙДЕНО');
if (fr) {
  await fr.waitForSelector('#op-prod-q', { state: 'attached', timeout: 15000 });
  await fr.evaluate(() => { document.getElementById('op-prod').style.display = 'block'; });
  await fr.fill('#op-prod-q', 'кондиціонер'); await fr.evaluate(() => opProdSearch()); await p.waitForTimeout(1800);
  const all = await srv('кондиціонер'); const r = await fr.evaluate(() => [...document.querySelectorAll('#op-prod-res [onclick]')].map(d => d.textContent));
  check('Операция в кассе «кондиціонер»', r.length === Math.min(all.length, 50) && /QA кондиціонер/.test(r[0] || ''), `сервер ${all.length}, на экране ${r.length}, первый: ${(r[0]||'').slice(0,45)}`);
} else check('Операция в кассе', false, 'окно не открылось');

await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.evaluate(async ([id, vid]) => { await api('/api/admin/variants/' + vid + '/stock', { method: 'POST', body: JSON.stringify({ qty: -1, note: 'QA откат' }) }).catch(()=>{});
  await api('/api/admin/products/' + encodeURIComponent(id), { method: 'DELETE' }); }, [FID, fx]);
// уборка хвостов прошлых прогонов + проверка: удалённый товар исчезает из продажи
await p.evaluate(async () => { const d = await api('/api/admin/products?limit=5000'); const list = d.items || d.products || d || [];
  for (const x of list) if (String(x.id).startsWith('qa-kond-zhuravl-2509-') && x.active !== false) await api('/api/admin/products/' + encodeURIComponent(x.id), { method: 'DELETE' }).catch(() => null); });
{ const left = await srv('QA кондиціонер NA Golovy');
  check('Удалённый товар исчез из продажи', left.every(v => !String(v.product_name).startsWith('QA кондиціонер NA Golovy')) , 'осталось ' + left.length); }
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
console.log(fail ? `ИТОГ: ${fail} провалов` : 'ИТОГ: всё зелёное');
await b.close();
process.exit(fail || errs.length ? 1 : 0);
