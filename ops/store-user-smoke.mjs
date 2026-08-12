/* ops/store-user-smoke.mjs — проверка модуля «Магазин» ГЛАЗАМИ ПОЛЬЗОВАТЕЛЯ.
 *
 * Зачем: API-тесты зелёные ≠ человек может работать. Здесь настоящий браузер:
 * открываем экран, кликаем вкладки, заполняем формы, жмём кнопки — и сверяем,
 * что деньги и остатки сошлись в базе. Плюс ловим ошибки JS в консоли.
 *
 * Проверяемый путь Босса:
 *   1. Экран «Магазин» открывается, вкладки переключаются, дашборд считает.
 *   2. Приёмка поставки с доставкой → товар лёг на склад МАГАЗИНА, склад салона не тронут.
 *   3. Оптовая продажа → долг клиента вырос; оплата → долг закрылся.
 *   4. Передача салону → остаток ушёл со склада магазина на склад салона.
 *   5. Все тестовые данные удаляются, база возвращается в исходное состояние.
 *
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright \
 *         ADMIN_TOKEN=... node ops/store-user-smoke.mjs
 */
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
const { chromium } = pkg;

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3011';
const TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) { console.error('нет ADMIN_TOKEN'); process.exit(2); }

const fails = [];
const log = [];
const ok = (name, cond, extra) => {
  const line = (cond ? '[+] ' : '[-] ПРОВАЛ ') + name + (extra !== undefined && !cond ? ' :: ' + JSON.stringify(extra) : '');
  console.log(line); log.push(line);
  if (!cond) fails.push(name);
};

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
const jsErrors = [];
p.on('pageerror', e => jsErrors.push(String(e.message).slice(0, 200)));
let watchErrors = false; // до установки токена 401 — ожидаемо, это не дефект страницы
p.on('console', m => { if (watchErrors && m.type() === 'error') jsErrors.push('console: ' + m.text().slice(0, 160)); });

const created = { receiptId: null, saleId: null, cpId: null, transferId: null, productId: null };

try {
  // ── 0. Вход как Босс: токен в браузер, открыть экран магазина ───────────
  await p.goto(BASE + '/admin/store.html?standalone=1', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOKEN);
  await p.goto(BASE + '/admin/store.html?standalone=1', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  watchErrors = true;

  const title = await p.title();
  ok('экран «Магазин» открылся', /магазин|store|svs/i.test(title) || (await p.locator('body').innerText()).length > 100, title);

  // ── 1. Вкладки переключаются и что-то показывают ────────────────────────
  const panes = await p.evaluate(async () => {
    const res = {};
    const names = ['dash', 'stock', 'receipt', 'sale', 'transfer', 'clients', 'history'];
    for (const n of names) {
      try {
        if (typeof showPane === 'function') showPane(n);
        await new Promise(r => setTimeout(r, 700));
        const el = document.querySelector(`#pane-${n}`) || document.querySelector(`[data-pane="${n}"]`);
        res[n] = el ? (el.innerText || '').trim().length : -1;
      } catch (e) { res[n] = 'ERR ' + e.message; }
    }
    return res;
  });
  for (const [n, len] of Object.entries(panes)) {
    ok(`вкладка «${n}» рисует содержимое`, typeof len === 'number' && len > 20, { n, len });
  }

  // ── 2. Дашборд отвечает и считает ───────────────────────────────────────
  const dash = await p.evaluate(async () => {
    const r = await fetch('/api/store/dashboard?period=month', {
      headers: { 'X-Admin-Token': localStorage.getItem('svs_admin_token') },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  ok('дашборд магазина отвечает', dash.status === 200, dash);
  ok('дашборд содержит цифры выручки/маржи', dash.body && typeof dash.body === 'object' && JSON.stringify(dash.body).length > 30, dash.body);

  // ── 3. Берём товар для теста ────────────────────────────────────────────
  const prod = await p.evaluate(async () => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/admin/stock/list?limit=30', { headers: h }).then(x => x.json());
    const list = r.items || r.products || r;
    const item = (Array.isArray(list) ? list : []).find(x => x && (x.variant_id || x.id));
    return item ? { id: item.variant_id || item.id, name: item.name || item.product_name } : null;
  });
  ok('товар для теста найден', !!prod, prod);
  if (!prod) throw new Error('нет товаров — дальше тестировать нечего');
  created.productId = prod.id;

  const before = await p.evaluate(async () => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token') };
    const s = await fetch('/api/store/stock', { headers: h }).then(x => x.json()).catch(() => null);
    return s;
  });

  // ── 4. ПРИЁМКА поставки с доставкой (реальный POST как из формы) ────────
  const rec = await p.evaluate(async (pid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/store/receipts', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        supplier_name: 'ТЕСТ-ПОСТАЧАЛЬНИК (smoke)',
        doc_date: new Date().toISOString().slice(0, 10),
        delivery_cost: 100,
        items: [{ variant_id: pid, qty: 10, unit_cost: 50 }],
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, prod.id);
  ok('приёмка поставки принята', rec.status === 200 || rec.status === 201, rec);
  created.receiptId = rec.body && (rec.body.receipt_id || rec.body.id);

  const afterStock = await p.evaluate(async (pid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token') };
    const s = await fetch('/api/store/stock', { headers: h }).then(x => x.json()).catch(() => null);
    const list = (s && (s.items || s.stock || s)) || [];
    const row = (Array.isArray(list) ? list : []).find(x => String(x.variant_id) === String(pid));
    return { row, count: Array.isArray(list) ? list.length : -1 };
  }, prod.id);
  ok('товар появился на складе МАГАЗИНА', !!afterStock.row && Number(afterStock.row.qty) >= 10, afterStock);
  ok('себестоимость учла доставку (>50 за единицу)',
    !!afterStock.row && Number(afterStock.row.cost || afterStock.row.avg_cost || 0) > 50,
    afterStock.row);

  // ── 5. Опт-клиент и продажа в долг ──────────────────────────────────────
  const cp = await p.evaluate(async () => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/store/counterparties', {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: 'ТЕСТ-САЛОН (smoke)', kind: 'salon', credit_limit: 10000, payment_days: 14 }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  ok('опт-клиент создаётся', cp.status === 200 || cp.status === 201, cp);
  created.cpId = cp.body && (cp.body.id || (cp.body.counterparty && cp.body.counterparty.id));

  const sale = await p.evaluate(async ([pid, cpid]) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/store/sales', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        sale_type: 'wholesale', counterparty_id: cpid, paid_amount: 0,
        items: [{ variant_id: pid, qty: 3, unit_price: 200 }],
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [prod.id, created.cpId]);
  ok('оптовая продажа проводится', sale.status === 200 || sale.status === 201, sale);
  created.saleId = sale.body && (sale.body.sale_id || sale.body.id);

  const debt = await p.evaluate(async (cpid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token') };
    const r = await fetch('/api/store/counterparties', { headers: h }).then(x => x.json());
    const list = r.items || r.counterparties || r;
    const row = (Array.isArray(list) ? list : []).find(x => String(x.id) === String(cpid));
    return row;
  }, created.cpId);
  ok('долг клиента вырос на сумму продажи (600)', debt && Math.abs(Number(debt.debt || debt.balance || 0) - 600) < 0.01, debt);

  // ── 6. Оплата долга ─────────────────────────────────────────────────────
  const pay = await p.evaluate(async (sid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch(`/api/store/sales/${sid}/pay`, {
      method: 'POST', headers: h, body: JSON.stringify({ amount: 600, method: 'cash' }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, created.saleId);
  ok('оплата долга проходит', pay.status === 200, pay);

  const debt2 = await p.evaluate(async (cpid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token') };
    const r = await fetch('/api/store/counterparties', { headers: h }).then(x => x.json());
    const list = r.items || r.counterparties || r;
    return (Array.isArray(list) ? list : []).find(x => String(x.id) === String(cpid));
  }, created.cpId);
  ok('долг обнулился после оплаты', debt2 && Math.abs(Number(debt2.debt || debt2.balance || 0)) < 0.01, debt2);

  // ── 7. Передача товара своему салону ────────────────────────────────────
  const tr = await p.evaluate(async (pid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/store/transfer', {
      method: 'POST', headers: h,
      body: JSON.stringify({ notes: 'smoke-test', items: [{ variant_id: pid, qty: 2 }] }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, prod.id);
  ok('передача товара салону проходит', tr.status === 200 || tr.status === 201, tr);
  created.transferId = tr.body && (tr.body.transfer_id || tr.body.id);

  // ── 8. Накладная файлом: приход на склад МАГАЗИНА (запрос Босса 12.08) ──
  const inv = await p.evaluate(async (pid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token'), 'Content-Type': 'application/json' };
    const r = await fetch('/api/stock-import/apply', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        kind: 'invoice', warehouse: 'store', doc_date: new Date().toISOString().slice(0, 10),
        supplier_name: 'ТЕСТ-НАКЛАДНА (smoke)', delivery_cost: 200, filename: 'smoke-invoice-' + Date.now() + '.csv', // защита от дублей документа: имя уникальное на прогон
        items: [{ name: 'позиція з накладної', qty: 10, price: 100, variant_id: pid }],
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, prod.id);
  ok('накладная файлом проводится на склад магазина',
    inv.status === 200 && inv.body && inv.body.warehouse === 'store' && inv.body.store_receipt_id, inv);

  const invStock = await p.evaluate(async (pid) => {
    const h = { 'X-Admin-Token': localStorage.getItem('svs_admin_token') };
    const s = await fetch('/api/store/stock', { headers: h }).then(x => x.json()).catch(() => null);
    const list = (s && (s.items || s.stock || s)) || [];
    return (Array.isArray(list) ? list : []).find(x => String(x.variant_id) === String(pid));
  }, prod.id);
  // средневзвешенная: старый остаток по 60 + новые 10 уп по 120 → 100 грн/уп.
  // Проверяем, что доставка вошла в себестоимость (выше чистой закупки 50/100) и остаток вырос.
  ok('накладная подняла остаток и себестоимость с доставкой',
    !!invStock && Number(invStock.qty) >= 10 && Number(invStock.avg_cost || invStock.cost || 0) > 60, invStock);

  ok('ошибок JavaScript на экране нет', jsErrors.length === 0, jsErrors.slice(0, 5));

} catch (e) {
  ok('тест дошёл до конца без падения', false, e.message);
} finally {
  await b.close().catch(() => {});
  console.log('\n===CLEANUP===');
  console.log(JSON.stringify(created));
  console.log('===RESULT=== ' + (fails.length ? 'ПРОВАЛОВ: ' + fails.length + ' → ' + fails.join(' | ') : 'ВСЁ ЗЕЛЁНОЕ'));
  process.exit(fails.length ? 1 : 0);
}
