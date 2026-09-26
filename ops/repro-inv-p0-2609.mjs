// [26.09 P0] акт інвентаризації: статус, «Провести акт», ціна, правка після проведення — в браузері (пісочниця).
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [], dialogs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.evaluate(() => openEmbed('/admin/crm-extra.html#inventory', 'fact_check Інвентаризація'));
await p.waitForTimeout(4000);
const fr = p.frames().find(f => f.url().includes('crm-extra.html'));
// акт на 2 позиції через той самий API (spot)
const aid = await fr.evaluate(async () => {
  const s = await api('/api/admin/stock/list');
  const vids = (s.items || []).filter(v => Number(v.stock_qty) >= 3).slice(0, 2).map(v => v.id);
  const r = await api('/api/inventory/audits', { method: 'POST', body: JSON.stringify({ scope: 'spot', scope_filter: { variant_ids: vids }, notes: 'QA-INV-P0-UI' }) });
  return r.audit_id;
});
await fr.evaluate(id => openAudit(id), aid); await p.waitForTimeout(2500);
const st1 = await fr.evaluate(() => ({ status: document.getElementById('inv-status-box').textContent, btn: getComputedStyle(document.getElementById('inv-actions')).display, price: document.querySelector('.inv-price')?.value, cols: document.querySelectorAll('.inv-tbl thead th').length }));
console.log('в роботі:', JSON.stringify(st1));
// факт першої позиції: облік − 1
const first = await fr.evaluate(() => { const it = INV_ITEMS[0]; return { id: it.id, exp: Number(it.expected_qty), vid: it.variant_id, price: Number(it.price) }; });
await fr.fill(`.inv-actual[data-id="${first.id}"]`, String(first.exp - 1));
await fr.press(`.inv-actual[data-id="${first.id}"]`, 'Enter'); await p.waitForTimeout(1200);
// ціна
await fr.fill(`.inv-price[data-vid="${first.vid}"]`, String(first.price + 1));
await fr.press(`.inv-price[data-vid="${first.vid}"]`, 'Enter'); await p.waitForTimeout(1500);
const pm = await fr.evaluate(v => document.querySelector(`.inv-price-msg[data-vid="${v}"]`).textContent, first.vid);
console.log('ціна:', pm);
await p.screenshot({ path: '/tmp/inv-p0-before.png' });
await fr.click('#inv-complete-btn'); await p.waitForTimeout(4000);
const st2 = await fr.evaluate(() => ({ status: document.getElementById('inv-status-box').textContent, note: document.getElementById('inv-detail-note').textContent, btn: getComputedStyle(document.getElementById('inv-actions')).display }));
console.log('підтвердження:', dialogs[0]); console.log('проведено:', JSON.stringify(st2));
// правка після проведення
await fr.fill(`.inv-actual[data-id="${first.id}"]`, String(first.exp - 2));
await fr.press(`.inv-actual[data-id="${first.id}"]`, 'Enter'); await p.waitForTimeout(1500);
console.log('після проведення:', await fr.evaluate(() => document.getElementById('inv-detail-note').textContent));
const fin = await fr.evaluate(async (a) => { const s = await api('/api/admin/stock/list'); const v = s.items.find(x => x.id === a.vid); return { stock: Number(v.stock_qty), price: Number(v.price) }; }, first);
console.log('склад:', JSON.stringify(fin), 'очікували залишок', first.exp - 2, 'ціну', first.price + 1);
await p.screenshot({ path: '/tmp/inv-p0-after.png' });
// прибрати ціну назад
await fr.evaluate(async (a) => api('/api/admin/variants/' + a.vid, { method: 'PATCH', body: JSON.stringify({ price: a.price }) }), first);
console.log('помилки JS:', errs.length ? errs : 'немає', '| aid', aid);
await b.close();
