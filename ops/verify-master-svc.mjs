/* ops/verify-master-svc.mjs — проверка ЕДИНОЙ карточки мастера сценарием Босса:
 * index.html → раздел «Майстри/Співробітники» (embed crm-extra) → openMasterCard из iframe
 * → должна открыться карточка КАРКАСА с вкладкой «Послуги» (управление, не статистика).
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=... ADMIN_TOKEN=... [SMOKE_BASE=...] node ops/verify-master-svc.mjs */
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
const { chromium } = pkg;
const BASE = process.env.SMOKE_BASE || 'https://svs-shop-api-backup.onrender.com';
const TOKEN = process.env.ADMIN_TOKEN;
const SHOT = '/tmp/master-svc-verify.png';

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let result = { ok: false, shot: SHOT };
try {
  await p.goto(BASE + '/admin/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.evaluate(t => { try { localStorage.setItem('svs_admin_token', t); } catch (_) {} }, TOKEN);
  await p.goto(BASE + '/admin/index.html', { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(2500);

  // открываем раздел «Майстри / Співробітники» (embed crm-extra#users)
  await p.evaluate(() => openEmbed('/admin/crm-extra.html#users', 'Майстри / Співробітники'));
  await p.waitForTimeout(3500);

  // из iframe вызываем openMasterCard — с фиксом 3c679d6 он должен делегировать в parent
  const r = await p.evaluate(async () => {
    const f = document.getElementById('embedFrame');
    const w = f && f.contentWindow;
    if (!w || typeof w.openMasterCard !== 'function') return { err: 'iframe/openMasterCard недоступны' };
    let mid = null;
    try {
      const list = await w.api('/api/schedule/masters');
      const arr = list.items || list.masters || list;
      const m = arr.find(x => /Кушнерук/i.test(x.name || '')) || arr.find(x => x.active !== false) || arr[0];
      mid = m && m.id;
    } catch (e) { return { err: 'masters api: ' + e.message }; }
    if (!mid) return { err: 'мастера не найдены' };
    await w.openMasterCard(mid);
    await new Promise(res => setTimeout(res, 1800));
    // единая карточка = модалка в РОДИТЕЛЕ (index.html)
    const delegated = typeof mcTab === 'function' && document.getElementById('mcTabBody') != null;
    if (!delegated) return { err: 'карточка НЕ делегировалась в каркас (открылась локальная в iframe?)', delegated: false };
    mcTab('services');
    await new Promise(res => setTimeout(res, 2600));
    const addBtn = [...document.querySelectorAll('button')].some(x => (x.textContent || '').includes('Додати послугу'));
    const box = document.getElementById('mcSvcList');
    const rows = box ? box.querySelectorAll('input[type=number]').length : 0;
    const emptyTxt = box && /Звʼязок ще немає/.test(box.textContent || '');
    return { delegated: true, addBtn, rows, emptyTxt: !!emptyTxt };
  });

  await p.screenshot({ path: SHOT, fullPage: false });
  if (r.err) result = { ok: false, reason: r.err, shot: SHOT, ...r };
  else if (!r.addBtn) result = { ok: false, reason: 'нет кнопки Додати послугу', shot: SHOT, ...r };
  else if (r.rows === 0 && !r.emptyTxt) result = { ok: false, reason: 'список не отрисовался', shot: SHOT, ...r };
  else result = { ok: true, shot: SHOT, master: 'через розділ Майстри', ...r };
} catch (e) {
  try { await p.screenshot({ path: SHOT }); } catch {}
  result = { ok: false, reason: e.message, shot: SHOT };
}
await b.close();
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
