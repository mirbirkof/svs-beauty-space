/* Проверка рабочей вкладки «Послуги» в карточке мастера, открытой из index.html
 * (Дашборд → Топ майстри → клик по имени). Эта карточка УЖЕ живёт на проде (bdf31f0).
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=... ADMIN_TOKEN=... [SMOKE_BASE=...] node ops/verify-index-svc.mjs */
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
const { chromium } = pkg;
const BASE = process.env.SMOKE_BASE || 'https://svs-shop-api-backup.onrender.com';
const TOKEN = process.env.ADMIN_TOKEN;
const SHOT = '/tmp/index-svc-verify.png';

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let result = { ok: false, shot: SHOT };
try {
  await p.goto(BASE + '/admin/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.evaluate(t => { try { localStorage.setItem('svs_admin_token', t); } catch (_) {} }, TOKEN);
  await p.goto(BASE + '/admin/index.html', { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(2500);

  const r = await p.evaluate(async () => {
    // берём любого активного мастера
    let mid = null;
    try {
      const list = await api('/api/schedule/masters');
      const arr = list.items || list.masters || list;
      const m = arr.find(x => /Кушнерук/i.test(x.name || '')) || arr.find(x => x.active !== false) || arr[0];
      mid = m && m.id;
    } catch (e) { return { err: 'masters api: ' + e.message }; }
    if (!mid) return { err: 'мастера не найдены' };
    if (typeof openMasterCard !== 'function') return { err: 'openMasterCard нет в index.html' };
    await openMasterCard(mid);
    await new Promise(res => setTimeout(res, 1600));
    if (typeof mcTab === 'function') mcTab('services');
    await new Promise(res => setTimeout(res, 2600));
    const addBtn = [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('Додати послугу'));
    const box = document.getElementById('mcSvcList');
    const rows = box ? box.querySelectorAll('input[type=number]').length : 0;
    const emptyTxt = box && /Звʼязок ще немає/.test(box.textContent || '');
    return { addBtn, rows, emptyTxt: !!emptyTxt };
  });

  await p.screenshot({ path: SHOT, fullPage: false });
  if (r.err) result = { ok: false, reason: r.err, shot: SHOT };
  else if (!r.addBtn) result = { ok: false, reason: 'нет кнопки Додати послугу', shot: SHOT, ...r };
  else if (r.rows === 0 && !r.emptyTxt) result = { ok: false, reason: 'список не отрисовался', shot: SHOT, ...r };
  else result = { ok: true, shot: SHOT, ...r };
} catch (e) {
  try { await p.screenshot({ path: SHOT }); } catch {}
  result = { ok: false, reason: e.message, shot: SHOT };
}
await b.close();
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
