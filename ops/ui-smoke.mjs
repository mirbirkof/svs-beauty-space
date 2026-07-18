/* ops/ui-smoke.mjs — робо-сторож ключевых действий админки (Босс, 18.07.2026).
 * Реальные КЛИКИ в браузере (Playwright), а не только API — ловит регрессии UI
 * (типа «цена не сохраняется») ДО того, как их заметит Босс.
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright \
 *         ADMIN_TOKEN=... node ops/ui-smoke.mjs
 * Код выхода: 0 — всё зелёное, 1 — есть провал (для алерта).
 */
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
const { chromium } = pkg;
const BASE = process.env.SMOKE_BASE || 'https://svs-shop-api.onrender.com';
const TOKEN = process.env.ADMIN_TOKEN;
const fails = [];
const ok = (n, c) => { console.log((c ? '[+] ' : '[-] FAIL ') + n); if (!c) fails.push(n); };

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
try {
  await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOKEN);
  await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  // ── ТЕСТ 1: сохранение цены услуги через реальную форму ──
  const svc = await p.evaluate(async () => {
    const r = await api('/api/services?limit=1&sort=name');
    const s = (r.services || r.items || r)[0];
    return s ? { id: s.id, price: Number(s.price) } : null;
  });
  ok('услуга для теста найдена', !!svc);
  if (svc) {
    const newPrice = svc.price === 333 ? 334 : 333;
    const patched = await p.evaluate(async ([id, np]) => {
      if (window.svcEdit) svcEdit(id);
      await new Promise(r => setTimeout(r, 1500));
      const pf = document.getElementById('svcf_price');
      if (!pf) return { err: 'форма не открылась' };
      pf.value = String(np);
      const btn = document.getElementById('svcSaveBtn');
      if (!btn) return { err: 'кнопки Зберегти нет' };
      btn.click();
      await new Promise(r => setTimeout(r, 2500));
      const check = await api('/api/services/' + id);
      return { saved: Number((check.service || check).price) };
    }, [svc.id, newPrice]);
    ok('цена услуги сохранилась через форму', patched.saved === newPrice, patched);
    // вернуть исходную
    await p.evaluate(async ([id, pr]) => { await api('/api/services/' + id, { method: 'PATCH', body: JSON.stringify({ price: pr }) }); }, [svc.id, svc.price]);
  }

  // ── ТЕСТ 2: раздел «Послуги» открывается и рендерит список ──
  const listOk = await p.evaluate(async () => {
    try { go('services'); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
    const rows = document.querySelectorAll('[onclick*="svcEdit"]');
    return rows.length > 0;
  });
  ok('раздел Послуги рендерит список', listOk);

  // ── ТЕСТ 3: журнал открывается ──
  const journalOk = await p.evaluate(async () => {
    try { go('journal'); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
    return !!document.querySelector('#page-journal, .journal-grid, [id*="journal"]');
  });
  ok('журнал записів открывается', journalOk);

} catch (e) {
  ok('смоук без падения', false); console.error(e.message);
} finally {
  await b.close();
}
console.log(`\n=== UI-СМОУК: ${fails.length ? 'ЕСТЬ ПРОВАЛЫ (' + fails.join('; ') + ')' : 'ВСЁ ЗЕЛЁНОЕ'} ===`);
process.exit(fails.length ? 1 : 0);
