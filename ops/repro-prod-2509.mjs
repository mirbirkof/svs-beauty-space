// [25.09] жалоба 2: «змінюю ціну та кількість товару → Зберегти → Збережено, але нічого не змінюється».
// Путь админа: меню Склад → Товари → клик по названию → в строке варианта меняем Ціну и Залишок →
// жмём ГЛАВНУЮ кнопку сохранения карточки → перечитываем товар с сервера. ТОЛЬКО песочница :3037.
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const PID = process.env.REPRO_PRODUCT || '';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/api/notes')) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 160)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.evaluate(() => go('products'));
await p.waitForSelector('#productsBody tr td[onclick]', { timeout: 20000 });
const srv = (id) => p.evaluate(async (id) => {
  const r = await api('/api/admin/products/' + encodeURIComponent(id));
  const v = r.variants[0];
  const m = await api('/api/admin/stock/movements?variant_id=' + v.id + '&limit=5');
  return { vid: v.id, price: Number(v.price), stock: Number(v.stock_qty), moves: (m.items || []).map(x => `${x.reason}:${Number(x.delta)}`) };
}, id);
// товар: заданный или первый с одним вариантом
const pid = PID || await p.evaluate(() => (_ALL_PRODUCTS.find(x => +x.variants_count === 1 && x.name.startsWith('QA')) || _ALL_PRODUCTS.find(x => +x.variants_count === 1)).id);
const before = await srv(pid);
console.log('товар', pid, 'ДО:', JSON.stringify(before));
await p.evaluate((id) => openProduct(id), pid);
await p.waitForSelector(`#v${before.vid}_price`, { timeout: 15000 });
const newPrice = before.price + 11, newStock = before.stock + 3;
await p.fill(`#v${before.vid}_price`, String(newPrice));
await p.fill(`#v${before.vid}_stock`, String(newStock));
// главная кнопка сохранения карточки (не маленькая 💾 в строке)
const mainBtn = await p.$('#prodDetail button.btn-primary');
console.log('главная кнопка:', JSON.stringify(await mainBtn.textContent()));
await mainBtn.click();
await p.waitForTimeout(5000);
const msg = await p.evaluate(() => (document.getElementById('pm_msg') || {}).textContent || '');
const onScreen = await p.evaluate((vid) => ({ price: document.getElementById('v' + vid + '_price')?.value, stock: document.getElementById('v' + vid + '_stock')?.value }), before.vid);
await p.screenshot({ path: process.env.SHOT || '/tmp/repro-prod.png' });
const after = await srv(pid);
console.log('сообщение на экране:', JSON.stringify(msg), '| поля на экране:', JSON.stringify(onScreen));
console.log('ПОСЛЕ (перечитано с сервера):', JSON.stringify(after));
const ok = after.price === newPrice && after.stock === newStock;
console.log('ВЫВОД:', ok ? `СОХРАНИЛОСЬ: цена ${before.price}→${after.price}, кол-во ${before.stock}→${after.stock}` : `НЕ СОХРАНИЛОСЬ при сообщении «${msg}»: цена ${after.price} (ждали ${newPrice}), кол-во ${after.stock} (ждали ${newStock})`);
// вернуть песочницу как было
await p.evaluate(async ([vid, pr, st]) => api('/api/admin/variants/' + vid, { method: 'PATCH', body: JSON.stringify({ price: pr, stock_qty: st }) }), [before.vid, before.price, before.stock]);
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
await b.close();
