// [25.09 Jarvis] воспроизведение: «акт інвентаризації створений, але не відкривається» — путь админа:
// главная админка → меню «Інвентаризація» (встроенное окно crm-extra.html#inventory) → создать → «Відкр.».
// REPRO_CREATE=1 — создать акт (ТОЛЬКО песочница :3037).
import { chromium } from 'playwright';
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const VW = +(process.env.REPRO_W || 1280), VH = +(process.env.REPRO_H || 800);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: VW, height: VH } });
const errs = [];
p.on('pageerror', e => errs.push('JS: ' + e.message));
p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/api/notes')) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
p.on('dialog', async d => { errs.push('ALERT: ' + d.message().slice(0, 160)); await d.accept(); });
await loginIntoPage(p, BASE, process.env.QA_UI_PHONE || process.env.QA_FUZZ_PHONE, process.env.QA_UI_PASSWORD || process.env.QA_FUZZ_PASSWORD);
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.click('a.sidebar-item[data-embed*="#inventory"]');
await p.waitForTimeout(4000);
const fr = p.frames().find(f => f.url().includes('crm-extra.html'));
if (!fr) { console.log('встроенного окна нет'); await b.close(); process.exit(1); }
const ifr = await p.$('iframe'); const ib = ifr ? await ifr.boundingBox() : null;
console.log('встроенное окно:', ib ? `${Math.round(ib.width)}x${Math.round(ib.height)} с y=${Math.round(ib.y)}` : '—');
if (process.env.REPRO_CREATE) {
  await fr.selectOption('#inv-scope', 'full').catch(() => {});
  await fr.click('button[onclick*="createAudit"]').catch(e => errs.push('create: ' + e.message.slice(0, 100)));
  await p.waitForTimeout(8000);
} else {
  const btn = await fr.$('#inv-list button');
  console.log('кнопка Відкр.:', !!btn);
  if (btn) { await btn.click(); await p.waitForTimeout(6000); }
}
const st = await fr.evaluate(() => {
  const c = document.getElementById('inv-detail-card'); const r = c.getBoundingClientRect();
  return { display: getComputedStyle(c).display, top: Math.round(r.top + scrollY), rows: document.querySelectorAll('#inv-items tr').length,
    title: (document.getElementById('inv-detail-no') || {}).textContent, docH: document.documentElement.scrollHeight, scrollY: Math.round(scrollY),
    innerH: innerHeight, acts: document.querySelectorAll('#inv-list tr').length };
});
console.log('карточка акта:', JSON.stringify(st));
console.log(st.display !== 'none' && st.top > st.scrollY + st.innerH ? `ВЫВОД: карточка открыта, но НИЖЕ видимой области (y=${st.top}, видно до ${st.scrollY + st.innerH})` : 'ВЫВОД: карточка ' + (st.display === 'none' ? 'НЕ открылась' : 'в видимой области'));
await p.screenshot({ path: '/tmp/repro-inv.png' });
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
await b.close();
