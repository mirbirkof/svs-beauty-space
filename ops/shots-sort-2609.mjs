// [26.09 crm-sort-2609] Скриншоти складу салону, складу магазину і акту інвентаризації (ПК 1280×800).
// Працює і на старому, і на новому інтерфейсі (ті самі id пошуку). SHOT_TAG=before|after.
// Запуск: node -r dotenv/config /tmp/qa-run.js ../ops/shots-sort-2609.mjs
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
import fs from 'node:fs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const TAG = process.env.SHOT_TAG || 'before';
const Q = process.env.SHOT_Q || 'extremo';
const OUT = '/tmp/sort-shots'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 160)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
const names = async (sel, fr = p) => fr.evaluate(s => Array.from(document.querySelectorAll(s)).map(e => e.textContent.trim().replace(/\s+/g, ' ')).slice(0, 40), sel);

// 1) склад салону
await p.evaluate(() => go('stock'));
await p.waitForTimeout(2500);
await p.fill('#stListSearch', Q); await p.waitForTimeout(2500);
console.log('САЛОН (пошук «' + Q + '»):', (await names('#stListBody tr td:first-child > span, #stListBody tr td:first-child .st-name')).join(' | '));
await p.screenshot({ path: `${OUT}/${TAG}-1-salon.png` });

// 2) склад магазину
await p.evaluate(() => openEmbed('/admin/store.html', 'storefront Магазин'));
await p.waitForTimeout(3000);
let fr = p.frames().find(f => f.url().includes('store.html'));
await fr.evaluate(() => showPane('stock')); await p.waitForTimeout(2500);
console.log('МАГАЗИН:', (await names('#stockBody tr:not(.sv-grp) td:first-child', fr)).join(' | '));
await p.screenshot({ path: `${OUT}/${TAG}-2-store.png` });

// 3) акт інвентаризації салону (новий повний акт у пісочниці; id — у state для прибирання)
await p.evaluate(() => openEmbed('/admin/crm-extra.html#inventory', 'fact_check Інвентаризація'));
await p.waitForTimeout(4000);
fr = p.frames().find(f => f.url().includes('crm-extra.html'));
const id = await fr.evaluate(async () => (await api('/api/inventory/audits', { method: 'POST', body: JSON.stringify({ scope: 'full', notes: 'qasort shots' }) })).audit_id);
try { const f = '/tmp/qasort-state.json'; const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.audits = [...new Set([...(s.audits || []), id])]; fs.writeFileSync(f, JSON.stringify(s)); } catch (_) {}
await fr.evaluate(async (id) => { await loadInventory(); await openAudit(id); }, id);
await p.waitForTimeout(3000);
await fr.fill('#inv-search', Q); await p.waitForTimeout(1500);
console.log('АКТ #' + id + ':', (await names('#inv-items tr:not(.sv-grp) td:first-child', fr)).join(' | '));
await p.screenshot({ path: `${OUT}/${TAG}-3-inventory.png` });
console.log('ОШИБКИ:', errs.length ? errs.join('\n  ') : 'нет');
await b.close();
