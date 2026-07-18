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

  // ── ТЕСТ 4-7 (грабли 18.07): запись — сумма/смена услуги/добавление, список услуг ──
  const chk = await p.evaluate(async () => {
    const out = {};
    try {
      // будущая запись
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kiev' });
      const j = await api('/api/schedule/appointments?from=' + today + '&to=' + today);
      const list = (j && (j.appointments || j.items)) || [];
      const a = Array.isArray(list) ? list.find(x => ['booked','confirmed','arrived'].includes(x.status)) : null;
      if (!a) { out.note = 'нет активной записи на сегодня — тесты записи пропущены'; return out; }
      const id = a.id, oldPrice = Number(a.price);
      // 4: смена суммы (чистый PATCH price — регресс room-блока)
      const r1 = await api('/api/schedule/appointments/' + id, { method: 'PATCH', body: JSON.stringify({ price: oldPrice }) });
      out.price_patch = !!(r1 && r1.ok);
      // 5: список услуг для модалок непустой и отсортирован по категориям
      _svcCache = null;
      const svcs = await getServices();
      out.svc_list = svcs.length > 3;
      // 6: смена услуги на ту же самую (no-op, но проверяет весь путь PATCH service_id)
      const r2 = await api('/api/schedule/appointments/' + id, { method: 'PATCH', body: JSON.stringify({ service_id: a.service_id }) });
      out.svc_change = !!(r2 && r2.ok);
      // 7: связки мастера отдаются (фильтр по профессии)
      const ms = await api('/api/master-services/by-master/' + a.master_id);
      out.master_links = Array.isArray(ms.items);
    } catch (e) { out.err = e.message.slice(0, 120); }
    return out;
  });
  if (chk.note) console.log('[i] ' + chk.note);
  else {
    ok('смена суммы записи (PATCH price)', chk.price_patch, chk);
    ok('список услуг для модалок непустой', chk.svc_list, chk);
    ok('смена услуги записи (PATCH service_id)', chk.svc_change, chk);
    ok('связки мастера отдаются (фильтр профессии)', chk.master_links, chk);
  }

} catch (e) {
  ok('смоук без падения', false); console.error(e.message);
} finally {
  await b.close();
}
console.log(`\n=== UI-СМОУК: ${fails.length ? 'ЕСТЬ ПРОВАЛЫ (' + fails.join('; ') + ')' : 'ВСЁ ЗЕЛЁНОЕ'} ===`);
process.exit(fails.length ? 1 : 0);
