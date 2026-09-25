// [25.09 Jarvis] воспроизведение: «акт інвентаризації створений, але не відкривається». ТОЛЬКО ЧТЕНИЕ.
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3011';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
p.on('requestfailed', r => errs.push('FAILED ' + r.method() + ' ' + r.url().replace(BASE,'') + ' — ' + (r.failure()||{}).errorText));
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 200)); await d.dismiss(); });
if (process.env.QA_ADMIN_TOKEN) {   // песочный сервер: одноразовый токен владельца из startQaServer
  await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => localStorage.setItem('svs_admin_token', t), process.env.QA_ADMIN_TOKEN);
} else await loginIntoPage(p, BASE, process.env.QA_UI_PHONE || process.env.QA_FUZZ_PHONE, process.env.QA_UI_PASSWORD || process.env.QA_FUZZ_PASSWORD);
await p.goto(BASE + '/admin/crm-extra.html#inventory', { waitUntil: 'networkidle' });
await p.waitForTimeout(3000); await p.screenshot({ path: '/tmp/repro-inv-0.png' }); console.log('адрес:', p.url());
if (process.env.REPRO_CREATE) {   // только песочница: создать акт, как админ
  await p.selectOption('#inv-scope', 'full').catch(()=>{});
  await p.click('button[onclick*="createAudit"]').catch(e => errs.push('create: ' + e.message.slice(0, 120)));
  await p.waitForTimeout(6000);
}
await p.waitForTimeout(2500);
const rows = await p.$$eval('#inv-list tr', t => t.length);
const btn = await p.$('#inv-list button');
console.log('строк актов:', rows, '| кнопка Відкр.:', !!btn);
if (btn) {
  const vis = await btn.isVisible(); console.log('кнопка видима:', vis);
  const t0 = Date.now();
  await btn.click().catch(e => errs.push('click: ' + e.message.slice(0, 200)));
  await p.waitForTimeout(8000);
  const card = await p.$eval('#inv-detail-card', e => ({ display: getComputedStyle(e).display, rows: e.querySelectorAll('tr').length, title: (document.getElementById('inv-detail-no') || {}).textContent })).catch(e => 'нет карточки: ' + e.message);
  console.log('карточка через', Date.now() - t0, 'мс:', JSON.stringify(card));
  const box = await p.$eval('#inv-detail-card', e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), h: Math.round(r.height) }; }).catch(() => null);
  console.log('положение карточки на странице:', JSON.stringify(box), '| высота окна 900');
  await p.screenshot({ path: '/tmp/repro-inv.png', fullPage: false });
}
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
await b.close();
