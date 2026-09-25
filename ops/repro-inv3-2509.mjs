// [25.09] жалоба 1: акт создан, но не открывается. Путь админа через меню (встроенное окно).
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });
p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/api/notes')) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 160)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.evaluate(() => openEmbed('/admin/crm-extra.html#inventory', 'fact_check Інвентаризація'));
await p.waitForTimeout(5000);
const fr = p.frames().find(f => f.url().includes('crm-extra.html'));
if (!fr) { console.log('встроенного окна нет', errs); await b.close(); process.exit(1); }
const ib = await (await p.$('#embedFrame')).boundingBox();
console.log('окно:', JSON.stringify(ib));
const t0 = Date.now();
if (process.env.REPRO_CREATE) {
  const before = await fr.evaluate(() => document.querySelectorAll('#inv-list tr').length);
  const btn = await fr.$('button[onclick*="createAudit"]');
  // двойной клик, как нетерпеливый админ
  await btn.click(); await btn.click({ force: true }).catch(()=>{});
  await p.waitForTimeout(15000);
  const after = await fr.evaluate(() => document.querySelectorAll('#inv-list tr').length);
  console.log('строк актов до/после:', before, after);
} else {
  const btn = await fr.$('#inv-list button');
  console.log('кнопка Відкр.:', !!btn);
  if (btn) { await btn.click(); await p.waitForTimeout(8000); }
}
const st = await fr.evaluate(() => {
  const c = document.getElementById('inv-detail-card'); const r = c.getBoundingClientRect();
  return { display: getComputedStyle(c).display, top: Math.round(r.top), rows: document.querySelectorAll('#inv-items tr').length,
    firstInput: !!document.querySelector('.inv-actual'), inputTop: (()=>{const f=document.querySelector('.inv-actual'); return f?Math.round(f.getBoundingClientRect().top):null})(), title: (document.getElementById('inv-detail-no') || {}).textContent,
    docH: document.documentElement.scrollHeight, scrollY: Math.round(scrollY), innerH: innerHeight };
});
console.log('карточка:', JSON.stringify(st), 'за', Date.now() - t0, 'мс');
const visible = st.display !== 'none' && st.inputTop != null && st.inputTop >= 0 && st.inputTop < st.innerH - 20;
console.log('ВЫВОД:', st.display === 'none' ? 'КАРТОЧКА НЕ ОТКРЫЛАСЬ' : visible ? 'карточка и поле «Факт» ВИДНЫ в окне' : `карточка открыта, но поля для заполнения ВНЕ видимой области (поле y=${st.inputTop}, окно ${st.innerH})`);
await p.screenshot({ path: process.env.SHOT || '/tmp/repro-inv3.png' });
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
await b.close();
