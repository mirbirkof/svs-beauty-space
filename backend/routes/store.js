/* SLS-11: Магазин (дистрибьютор) — склад, приёмка поставок, внутренняя продажа салону.
   Спека: workspace/tz_modules/v2/sls_11_wholesale_retail_DRAFT.md

   GET  /api/store/stock      — остатки склада магазина (+ себестоимость, стоимость склада)
   GET  /api/store/receipts   — история приёмок
   POST /api/store/receipts   — приёмка поставки:
        {supplier_name, doc_date:'YYYY-MM-DD', delivery_cost, notes, items:[{variant_id, qty, unit_cost}]}
        Доставка раскидывается в себестоимость позиций пропорционально их стоимости (landed cost).
   GET  /api/store/transfers  — история внутренних продаж
   POST /api/store/transfer   — внутренняя продажа Магазин → Салон (цена = ОПТ, решение Босса 12.08):
        {notes, items:[{variant_id, qty}]}
        Одна транзакция: -склад магазина, +склад салона (product_variants.stock_qty — канон),
        накладная internal_transfers с суммой и маржой. Защита от списания в минус.
*/
const express = require('express');
// Аудит 13.08: роутер магазину ходив у БД БЕЗ applyTenant — тобто в обхід RLS
// (прод-конект має BYPASSRLS). Списання зі складу магазину й записи продажів могли
// потрапити не в той салон. Тепер кожна транзакція магазину зажимається до свого тенанта,
// як це вже зроблено в orders.js / purchasing.js / stock-import.js.
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

router.use(requirePerm('stock.manage'));

// ── остатки склада магазина ─────────────────────────────
router.get('/stock', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT ws.variant_id, ws.qty, ws.reserved_qty, ws.avg_cost,
             v.sku, v.volume, v.price, v.wholesale,
             p.id AS product_id, p.name AS product_name, p.brand_id
        FROM warehouse_stock ws
        JOIN product_variants v ON v.id = ws.variant_id
        JOIN products p ON p.id = v.product_id
       WHERE ws.warehouse_id = 'store' AND ws.qty > 0
       ORDER BY p.name, v.volume`);
    const totalValue = r.rows.reduce((s, x) => s + Number(x.qty) * Number(x.avg_cost || 0), 0);
    res.json({ items: r.rows, total_value: Math.round(totalValue * 100) / 100 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── история приёмок ─────────────────────────────────────
router.get('/receipts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.id, r.supplier_name, r.doc_date, r.goods_total, r.delivery_cost,
             r.notes, r.created_by, r.created_at,
             COUNT(i.id)::int AS positions, COALESCE(SUM(i.qty),0)::numeric AS total_qty
        FROM store_receipts r
        LEFT JOIN store_receipt_items i ON i.receipt_id = r.id
       GROUP BY r.id ORDER BY r.created_at DESC LIMIT 200`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── приёмка поставки ────────────────────────────────────
router.post('/receipts', async (req, res) => {
  // Расчёт приёмки живёт в lib/store-receipt.js — им же пользуется импорт накладной
  // файлом/фото, чтобы себестоимость с доставкой считалась одинаково на обоих путях.
  const { createStoreReceipt } = require('../lib/store-receipt');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const out = await createStoreReceipt(client, {
      ...(req.body || {}),
      created_by: (req.user && (req.user.name || req.user.login)) || null,
    });
    await client.query('COMMIT');
    res.json({ ok: true, ...out });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

router.get('/transfers', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.id, t.total_amount, t.total_cost,
             (t.total_amount - t.total_cost) AS margin,
             t.notes, t.created_by, t.created_at,
             COUNT(i.id)::int AS positions, COALESCE(SUM(i.qty),0)::numeric AS total_qty
        FROM internal_transfers t
        LEFT JOIN internal_transfer_items i ON i.transfer_id = t.id
       GROUP BY t.id ORDER BY t.created_at DESC LIMIT 200`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── внутренняя продажа Магазин → Салон ──────────────────
router.post('/transfer', async (req, res) => {
  const { items, notes } = req.body || {};
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'порожній список позицій' });
  for (const it of items) {
    const q = Number(it.qty);
    if (!it.variant_id || !(q > 0) || !Number.isInteger(q))
      return res.status(400).json({ error: 'позиція: variant_id і ціла qty>0 (передача йде упаковками)' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const tr = (await client.query(
      `INSERT INTO internal_transfers (notes, created_by) VALUES ($1,$2) RETURNING id`,
      [notes || null, (req.user && (req.user.name || req.user.login)) || null])).rows[0];
    let totalAmount = 0, totalCost = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      const st = (await client.query(
        `SELECT ws.qty, ws.avg_cost, v.wholesale, v.price
           FROM warehouse_stock ws JOIN product_variants v ON v.id = ws.variant_id
          WHERE ws.variant_id = $1 AND ws.warehouse_id = 'store' FOR UPDATE OF ws`,
        [it.variant_id])).rows[0];
      if (!st) throw Object.assign(new Error(`Товару немає на складі магазину (variant ${it.variant_id})`), { user: true });
      if (Number(st.qty) < qty) throw Object.assign(new Error(`Недостатньо на складі магазину: є ${st.qty}, потрібно ${qty}`), { user: true });
      // Аудит 13.08: раніше `|| 0` мовчки проводив передачу по НУЛЬОВІЙ ціні (варіант без
      // ціни / нечислове значення) — товар зі складу зникав, грошей нема. Тепер відмова
      // з поясненням: ціну треба заповнити, а не «продати задарма».
      const priceRaw = st.wholesale != null ? st.wholesale : st.price;
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price <= 0) {
        throw Object.assign(new Error(`У товару (variant ${it.variant_id}) не задана оптова ціна — передача неможлива. Заповніть ціну в картці товару.`), { user: true });
      }
      const cost = Number(st.avg_cost) || 0;
      totalAmount += qty * price; totalCost += qty * cost;
      await client.query(
        `INSERT INTO internal_transfer_items (transfer_id, variant_id, qty, unit_price, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`, [tr.id, it.variant_id, qty, price, cost]);
      await client.query(
        `UPDATE warehouse_stock SET qty = qty - $2, updated_at = NOW()
          WHERE variant_id = $1 AND warehouse_id = 'store'`, [it.variant_id, qty]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:transfer_out',$3,'Внутрішній продаж: Магазин → Салон','store')`,
        [it.variant_id, -qty, tr.id]);
      // приход в салон: канон салонного остатка — product_variants.stock_qty
      await client.query(
        `UPDATE product_variants SET stock_qty = stock_qty + $2 WHERE id = $1`, [it.variant_id, qty]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:transfer_in',$3,'Закупівля у магазину (внутрішня накладна)','salon')`,
        [it.variant_id, qty, tr.id]);
    }
    await client.query(
      `UPDATE internal_transfers SET total_amount = $2, total_cost = $3 WHERE id = $1`,
      [tr.id, totalAmount, totalCost]);
    await client.query('COMMIT');
    res.json({
      ok: true, transfer_id: tr.id,
      total_amount: Math.round(totalAmount * 100) / 100,
      margin: Math.round((totalAmount - totalCost) * 100) / 100
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

/* ═══════════ ЭТАП 4: онлайн-канал (витрина) ═══════════
   Кто выдаёт товар по онлайн-заказу: склад САЛОНА (как исторически) или склад МАГАЗИНА.
   По умолчанию ВЫКЛЮЧЕНО — рабочий канал продаж не меняется, пока владелец сам не включит
   (и включить нельзя, пока склад магазина пуст: иначе заказы начнут падать «нет товара»). */
const ONLINE_KEY = 'store_fulfills_online';

router.get('/online-mode', async (req, res) => {
  try {
    const on = await require('../lib/settings').getSetting(ONLINE_KEY, false);
    const st = await pool.query(
      `SELECT COUNT(*)::int positions, COALESCE(SUM(qty),0)::numeric units
         FROM warehouse_stock WHERE warehouse_id='store' AND qty > 0`);
    res.json({ enabled: on === true || on === 'true', store_positions: st.rows[0].positions, store_units: Number(st.rows[0].units) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/online-mode', async (req, res) => {
  try {
    const enable = (req.body || {}).enabled === true;
    if (enable) {
      const st = await pool.query(
        `SELECT COUNT(*)::int n FROM warehouse_stock WHERE warehouse_id='store' AND qty > 0`);
      if (!st.rows[0].n)
        return res.status(400).json({ error: 'Склад магазину порожній — увімкнення заблоковано: онлайн-замовлення почали б падати. Спершу проведіть приймання поставки.' });
    }
    await require('../lib/settings').setSetting(ONLINE_KEY, enable, req.user && req.user.id);
    res.json({ ok: true, enabled: enable });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════ ЭТАП 3: опт-контрагенты, продажи, дашборд ═══════════ */

// ── контрагенты (опт-клиенты) с текущим долгом ──────────
router.get('/counterparties', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
             COALESCE(d.debt,0)::numeric      AS debt,
             COALESCE(d.overdue,0)::numeric   AS overdue_debt,
             COALESCE(d.turnover,0)::numeric  AS turnover
        FROM store_counterparties c
        LEFT JOIN (
          SELECT counterparty_id,
                 SUM(total_amount - paid_amount) AS debt,
                 SUM(CASE WHEN due_date < CURRENT_DATE THEN total_amount - paid_amount ELSE 0 END) AS overdue,
                 SUM(total_amount) AS turnover
            FROM store_sales
           WHERE counterparty_id IS NOT NULL
           GROUP BY counterparty_id
        ) d ON d.counterparty_id = c.id
       WHERE c.active
       ORDER BY c.is_own_salon DESC, c.name`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/counterparties', async (req, res) => {
  const { name, kind, phone, email, tax_id, credit_limit, payment_days, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Назва обовʼязкова' });
  try {
    const r = await pool.query(
      `INSERT INTO store_counterparties (name, kind, phone, email, tax_id, credit_limit, payment_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [String(name).trim(), kind || 'salon', phone || null, email || null, tax_id || null,
       Number(credit_limit) || 0, Number.isFinite(Number(payment_days)) ? Number(payment_days) : 30, notes || null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── список продаж ───────────────────────────────────────
router.get('/sales', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.sale_type, s.channel, s.total_amount, s.total_cost, s.paid_amount,
             (s.total_amount - s.paid_amount) AS debt,
             (s.total_amount - s.total_cost)  AS margin,
             (s.due_date IS NOT NULL AND s.due_date < CURRENT_DATE AND s.paid_amount < s.total_amount) AS overdue,
             s.due_date, s.buyer_name, s.created_by, s.created_at,
             c.name AS counterparty_name,
             COUNT(i.id)::int AS positions
        FROM store_sales s
        LEFT JOIN store_counterparties c ON c.id = s.counterparty_id
        LEFT JOIN store_sale_items i ON i.sale_id = s.id
       GROUP BY s.id, c.name
       ORDER BY s.created_at DESC LIMIT 200`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── продажа со склада магазина (опт / розница) ──────────
router.post('/sales', async (req, res) => {
  const { sale_type, counterparty_id, buyer_name, channel, paid_amount, notes, items } = req.body || {};
  if (!['wholesale', 'retail'].includes(sale_type))
    return res.status(400).json({ error: 'sale_type: wholesale або retail' });
  if (sale_type === 'wholesale' && !counterparty_id)
    return res.status(400).json({ error: 'Для оптового продажу потрібен контрагент' });
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'порожній список позицій' });
  for (const it of items) {
    if (!it.variant_id || !(Number(it.qty) > 0))
      return res.status(400).json({ error: 'позиція: потрібні variant_id і qty>0' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    let cp = null, dueDate = null;
    if (counterparty_id) {
      cp = (await client.query(`SELECT * FROM store_counterparties WHERE id=$1`, [counterparty_id])).rows[0];
      if (!cp) throw Object.assign(new Error('Контрагента не знайдено'), { user: true });
      if (cp.payment_days > 0) dueDate = new Date(Date.now() + cp.payment_days * 864e5).toISOString().slice(0, 10);
    }
    const sale = (await client.query(
      `INSERT INTO store_sales (sale_type, counterparty_id, buyer_name, channel, due_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sale_type, counterparty_id || null, buyer_name || null, channel || 'offline', dueDate, notes || null,
       (req.user && (req.user.name || req.user.login)) || null])).rows[0];
    let total = 0, cost = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      const st = (await client.query(
        `SELECT ws.qty, ws.avg_cost, v.wholesale, v.price
           FROM warehouse_stock ws JOIN product_variants v ON v.id = ws.variant_id
          WHERE ws.variant_id=$1 AND ws.warehouse_id='store' FOR UPDATE OF ws`, [it.variant_id])).rows[0];
      if (!st) throw Object.assign(new Error(`Товару немає на складі магазину (variant ${it.variant_id})`), { user: true });
      if (Number(st.qty) < qty) throw Object.assign(new Error(`Недостатньо на складі: є ${st.qty}, потрібно ${qty}`), { user: true });
      // цена: опт → wholesale, розница → price. Ручную цену разрешаем (акции), но не отрицательную.
      const base = sale_type === 'wholesale' ? (st.wholesale != null ? st.wholesale : st.price) : st.price;
      // Аудит 13.08: ручна ціна (акція) дозволена, зокрема 0 — це свідомий вибір продавця.
      // А ось МОВЧАЗНИЙ нуль через незаповнену ціну в картці — ні: товар списувався
      // зі складу, а виручка = 0. Тепер такий випадок відхиляємо з поясненням.
      let price;
      if (it.unit_price != null && Number.isFinite(Number(it.unit_price)) && Number(it.unit_price) >= 0) {
        price = Number(it.unit_price);
      } else {
        price = Number(base);
        if (!Number.isFinite(price) || price <= 0) {
          throw Object.assign(new Error(`У товару (variant ${it.variant_id}) не задана ціна — продаж неможливий. Заповніть ціну або вкажіть її вручну в документі.`), { user: true });
        }
      }
      const c = Number(st.avg_cost) || 0;
      total += qty * price; cost += qty * c;
      await client.query(
        `INSERT INTO store_sale_items (sale_id, variant_id, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
        [sale.id, it.variant_id, qty, price, c]);
      await client.query(
        `UPDATE warehouse_stock SET qty = qty - $2, updated_at = NOW()
          WHERE variant_id=$1 AND warehouse_id='store'`, [it.variant_id, qty]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,$3,$4,$5,'store')`,
        [it.variant_id, -qty, sale_type === 'wholesale' ? 'store:sale_wholesale' : 'store:sale_retail',
         sale.id, sale_type === 'wholesale' ? `Опт: ${cp ? cp.name : ''}`.slice(0, 200) : 'Роздрібний продаж']);
    }
    const paid = Math.min(Number(paid_amount) || 0, total);
    await client.query(
      `UPDATE store_sales SET total_amount=$2, total_cost=$3, paid_amount=$4 WHERE id=$1`,
      [sale.id, total, cost, paid]);
    if (paid > 0) await client.query(
      `INSERT INTO store_payments (sale_id, amount, created_by) VALUES ($1,$2,$3)`,
      [sale.id, paid, (req.user && (req.user.name || req.user.login)) || null]);
    // мягкое предупреждение по кредитному лимиту (не блокируем — решение владельца)
    let warning = null;
    if (cp && Number(cp.credit_limit) > 0) {
      const debt = Number((await client.query(
        `SELECT COALESCE(SUM(total_amount-paid_amount),0) d FROM store_sales WHERE counterparty_id=$1`,
        [cp.id])).rows[0].d);
      if (debt > Number(cp.credit_limit))
        warning = `Борг клієнта ${debt.toFixed(2)} грн перевищує ліміт ${Number(cp.credit_limit).toFixed(2)} грн`;
    }
    await client.query('COMMIT');
    res.json({
      ok: true, sale_id: sale.id,
      total: Math.round(total * 100) / 100,
      margin: Math.round((total - cost) * 100) / 100,
      debt: Math.round((total - paid) * 100) / 100,
      due_date: dueDate, warning
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

// ── оплата долга по продаже ─────────────────────────────
router.post('/sales/:id/pay', async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount має бути > 0' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const s = (await client.query(`SELECT total_amount, paid_amount FROM store_sales WHERE id=$1 FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!s) throw Object.assign(new Error('Продаж не знайдено'), { user: true });
    const rest = Number(s.total_amount) - Number(s.paid_amount);
    if (amount > rest + 0.001) throw Object.assign(new Error(`Залишок боргу ${rest.toFixed(2)} грн — більше внести не можна`), { user: true });
    await client.query(`UPDATE store_sales SET paid_amount = paid_amount + $2 WHERE id=$1`, [req.params.id, amount]);
    await client.query(`INSERT INTO store_payments (sale_id, amount, method, created_by) VALUES ($1,$2,$3,$4)`,
      [req.params.id, amount, (req.body || {}).method || 'bank', (req.user && (req.user.name || req.user.login)) || null]);
    await client.query('COMMIT');
    res.json({ ok: true, rest: Math.round((rest - amount) * 100) / 100 });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

// ── дашборд магазина: экономика за период ───────────────
router.get('/dashboard', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = `NOW() - INTERVAL '${days} days'`;
    const [rev, internal, debt, stock, topProd, topCli, deliv] = await Promise.all([
      // выручка и маржа внешних продаж по каналам
      pool.query(`SELECT sale_type, channel,
                         COALESCE(SUM(total_amount),0)::numeric revenue,
                         COALESCE(SUM(total_amount-total_cost),0)::numeric margin,
                         COUNT(*)::int cnt
                    FROM store_sales WHERE created_at >= ${since}
                   GROUP BY sale_type, channel`),
      // внутренние продажи салону
      pool.query(`SELECT COALESCE(SUM(total_amount),0)::numeric revenue,
                         COALESCE(SUM(total_amount-total_cost),0)::numeric margin,
                         COUNT(*)::int cnt
                    FROM internal_transfers WHERE created_at >= ${since}`),
      // дебиторка
      pool.query(`SELECT COALESCE(SUM(total_amount-paid_amount),0)::numeric debt,
                         COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN total_amount-paid_amount ELSE 0 END),0)::numeric overdue
                    FROM store_sales WHERE paid_amount < total_amount`),
      // склад в деньгах
      pool.query(`SELECT COALESCE(SUM(qty*avg_cost),0)::numeric value, COUNT(*)::int positions
                    FROM warehouse_stock WHERE warehouse_id='store' AND qty > 0`),
      // топ товаров (внешние продажи + внутренние)
      pool.query(`SELECT p.name AS product_name, v.volume,
                         SUM(x.qty)::numeric qty, SUM(x.amount)::numeric amount
                    FROM (
                      SELECT si.variant_id, si.qty, si.qty*si.unit_price AS amount
                        FROM store_sale_items si JOIN store_sales s ON s.id=si.sale_id
                       WHERE s.created_at >= ${since}
                      UNION ALL
                      SELECT ti.variant_id, ti.qty, ti.qty*ti.unit_price
                        FROM internal_transfer_items ti JOIN internal_transfers t ON t.id=ti.transfer_id
                       WHERE t.created_at >= ${since}
                    ) x
                    JOIN product_variants v ON v.id=x.variant_id
                    JOIN products p ON p.id=v.product_id
                   GROUP BY p.name, v.volume ORDER BY amount DESC LIMIT 10`),
      // топ клиентов
      pool.query(`SELECT c.name, COALESCE(SUM(s.total_amount),0)::numeric amount, COUNT(s.id)::int cnt
                    FROM store_sales s JOIN store_counterparties c ON c.id=s.counterparty_id
                   WHERE s.created_at >= ${since}
                   GROUP BY c.name ORDER BY amount DESC LIMIT 10`),
      // расходы на доставку поставок
      pool.query(`SELECT COALESCE(SUM(delivery_cost),0)::numeric delivery, COALESCE(SUM(goods_total),0)::numeric goods, COUNT(*)::int cnt
                    FROM store_receipts WHERE created_at >= ${since}`)
    ]);
    const sum = (rows, f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);
    const wholesale = rev.rows.filter(r => r.sale_type === 'wholesale');
    const retail = rev.rows.filter(r => r.sale_type === 'retail');
    // 15.08 (правило Боса «салон і магазин НЕ змішувати»): замовлення вітрини (orders)
    // раніше падали у касу САЛОНУ — у серпні це дало +8 112 ₴ чужих грошей у салоні.
    // Тепер салон їх не бачить, тож рахуємо їх ТУТ, у своєму дашборді, окремим рядком.
    // 15.08 (правило Боса «салон і магазин НЕ змішувати»): замовлення вітрини (orders)
    // раніше падали у касу САЛОНУ — у серпні це дало +8 112 ₴ чужих грошей у салоні.
    // Тепер салон їх не бачить, тож рахуємо їх ТУТ, у своєму дашборді.
    const ordersRow = await pool.query(
      `SELECT COALESCE(SUM(total),0)::numeric s, COUNT(*)::int n
         FROM orders WHERE status = 'paid' AND created_at >= NOW() - ($1 || ' days')::interval`,
      [String(days)]).catch(() => ({ rows: [{ s: 0, n: 0 }] }));
    const ordersRev = Number(ordersRow.rows[0]?.s || 0);
    const online = rev.rows.filter(r => r.channel === 'online');
    res.json({
      days,
      revenue: {
        wholesale: sum(wholesale, 'revenue'),
        retail: sum(retail, 'revenue'),
        online: sum(online, 'revenue') + ordersRev,
        internal: Number(internal.rows[0].revenue),
        total: sum(rev.rows, 'revenue') + Number(internal.rows[0].revenue)
      },
      margin: {
        external: sum(rev.rows, 'margin'),
        internal: Number(internal.rows[0].margin),
        total: sum(rev.rows, 'margin') + Number(internal.rows[0].margin)
      },
      receivables: { total: Number(debt.rows[0].debt), overdue: Number(debt.rows[0].overdue) },
      stock: { value: Number(stock.rows[0].value), positions: stock.rows[0].positions },
      purchases: { goods: Number(deliv.rows[0].goods), delivery: Number(deliv.rows[0].delivery), receipts: deliv.rows[0].cnt },
      sales_count: sum(rev.rows, 'cnt') + Number(internal.rows[0].cnt),
      top_products: topProd.rows,
      top_clients: topCli.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════ ЭТАП 5: інвентаризація складу МАГАЗИНА ═══════════
   Окремо від салонної інвентаризації (routes/inventory.js, inventory_audits,
   product_variants.stock_qty) — тут працюємо ТІЛЬКИ з warehouse_stock (warehouse_id='store').
   Урок сьогоднішнього бага салону: при закритті різниця рахується проти ПОТОЧНОГО залишку
   на момент закриття, а НЕ проти знімку на старті акта — інакше приймання/продажі, що
   сталися поки акт відкритий, стираються. */

// ── список актів (останні 20) зі зведенням по закритих ──
router.get('/inventory/acts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.id, a.status, a.note, a.created_by, a.created_at, a.closed_at,
             (SELECT COUNT(*) FROM store_inventory_lines l WHERE l.act_id=a.id AND l.counted_qty IS NOT NULL)::int AS counted_positions,
             (SELECT COUNT(*) FROM store_inventory_lines l WHERE l.act_id=a.id)::int AS total_positions,
             COALESCE(m.discrepancies, 0)::int AS discrepancies,
             COALESCE(m.shortage, 0)::numeric AS shortage_value,
             COALESCE(m.excess, 0)::numeric AS excess_value
        FROM store_inventory_acts a
        LEFT JOIN (
          SELECT sm.ref_id::int AS act_id,
                 COUNT(*)::int AS discrepancies,
                 SUM(CASE WHEN sm.delta < 0 THEN -sm.delta * COALESCE(ws.avg_cost,0) ELSE 0 END) AS shortage,
                 SUM(CASE WHEN sm.delta > 0 THEN  sm.delta * COALESCE(ws.avg_cost,0) ELSE 0 END) AS excess
            FROM stock_movements sm
            LEFT JOIN warehouse_stock ws ON ws.variant_id = sm.variant_id AND ws.warehouse_id = 'store'
           WHERE sm.reason = 'store:inventory_close'
           GROUP BY sm.ref_id
        ) m ON m.act_id = a.id
       ORDER BY a.created_at DESC LIMIT 20`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── створити акт; відмова якщо вже є відкритий ───────────
router.post('/inventory/acts', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const openAct = (await client.query(`SELECT id FROM store_inventory_acts WHERE status='open' LIMIT 1`)).rows[0];
    if (openAct) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Вже є відкритий акт інвентаризації', act_id: openAct.id });
    }
    const note = (req.body || {}).note || null;
    const r = await client.query(
      `INSERT INTO store_inventory_acts (note, created_by) VALUES ($1,$2) RETURNING id, status, note, created_at`,
      [note, (req.user && (req.user.name || req.user.login)) || null]);
    await client.query('COMMIT');
    res.json({ ok: true, act: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    // паралельне створення двома вкладками: частковий унікальний індекс відбʼє друге -> теж 409
    if (e.code === '23505') return res.status(409).json({ error: 'Вже є відкритий акт інвентаризації' });
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

// ── акт + рядки + ПОТОЧНІ залишки складу магазина (екран підрахунку) ──
router.get('/inventory/acts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const a = (await pool.query(`SELECT * FROM store_inventory_acts WHERE id=$1`, [id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not-found' });
    const items = await pool.query(`
      SELECT v.id AS variant_id, p.name AS product_name, v.volume, v.sku,
             ws.qty AS current_qty, ws.avg_cost,
             l.expected_qty, l.counted_qty, l.counted_by, l.counted_at
        FROM warehouse_stock ws
        JOIN product_variants v ON v.id = ws.variant_id
        JOIN products p ON p.id = v.product_id
        LEFT JOIN store_inventory_lines l ON l.act_id = $1 AND l.variant_id = ws.variant_id
       WHERE ws.warehouse_id = 'store'
       ORDER BY p.name, v.volume`, [id]);
    res.json({ act: a, items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── upsert факту по одній позиції ────────────────────────
router.put('/inventory/acts/:id/line', async (req, res) => {
  const id = Number(req.params.id);
  const { variant_id, counted_qty } = req.body || {};
  if (!variant_id) return res.status(400).json({ error: 'variant_id обовʼязковий' });
  if (counted_qty == null || !Number.isFinite(Number(counted_qty)) || Number(counted_qty) < 0)
    return res.status(400).json({ error: 'counted_qty має бути числом >= 0' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const act = (await client.query(`SELECT status FROM store_inventory_acts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!act) throw Object.assign(new Error('Акт не знайдено'), { user: true });
    if (act.status !== 'open') throw Object.assign(new Error('Акт не відкритий — редагування заблоковано'), { user: true });
    const st = (await client.query(
      `SELECT qty FROM warehouse_stock WHERE variant_id=$1 AND warehouse_id='store'`, [variant_id])).rows[0];
    const currentQty = st ? Number(st.qty) : 0;
    // expected_qty фіксується ЛИШЕ при першому введенні по цій позиції — довідково,
    // на подальші UPDATE (upsert) НЕ перезаписується, навіть якщо залишок склада змінився.
    const existing = (await client.query(
      `SELECT expected_qty FROM store_inventory_lines WHERE act_id=$1 AND variant_id=$2`, [id, variant_id])).rows[0];
    const expected = existing ? Number(existing.expected_qty) : currentQty;
    const by = (req.user && (req.user.name || req.user.login)) || null;
    await client.query(`
      INSERT INTO store_inventory_lines (act_id, variant_id, expected_qty, counted_qty, counted_by, counted_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (act_id, variant_id) DO UPDATE
        SET counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by, counted_at = NOW()`,
      [id, variant_id, expected, Number(counted_qty), by]);
    await client.query('COMMIT');
    res.json({ ok: true, expected_qty: expected, counted_qty: Number(counted_qty), diff: Number(counted_qty) - expected });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

// ── закриття акта: різниця рахується проти ПОТОЧНОГО qty, а не знімку на старті ──
router.post('/inventory/acts/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const act = (await client.query(`SELECT status FROM store_inventory_acts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!act) throw Object.assign(new Error('Акт не знайдено'), { user: true });
    if (act.status !== 'open') throw Object.assign(new Error('Акт вже не відкритий'), { user: true });
    const lines = (await client.query(
      `SELECT variant_id, expected_qty, counted_qty FROM store_inventory_lines WHERE act_id=$1 AND counted_qty IS NOT NULL`, [id])).rows;
    if (!lines.length) throw Object.assign(new Error('Немає жодної порахованої позиції — нема що закривати'), { user: true });

    const discrepancies = [];
    for (const line of lines) {
      const vinfo = (await client.query(
        `SELECT v.wholesale, v.volume, p.name AS product_name
           FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1`, [line.variant_id])).rows[0];
      // FOR UPDATE: захист від гонки з паралельним прийманням/продажем саме в момент закриття
      const st = (await client.query(
        `SELECT qty, avg_cost FROM warehouse_stock WHERE variant_id=$1 AND warehouse_id='store' FOR UPDATE`,
        [line.variant_id])).rows[0];
      const currentQty = st ? Number(st.qty) : 0;
      const counted = Number(line.counted_qty);
      const expected = line.expected_qty != null ? Number(line.expected_qty) : currentQty;
      // РОЗХОДЖЕННЯ, ЗНАЙДЕНЕ ПІДРАХУНКОМ, ізольовано від будь-яких інших рухів:
      // counted vs expected (залишок на МОМЕНТ ВВОДУ рядка). Якщо просто SET qty=counted_qty
      // (абсолютна перезаписка) — це ТОЧНО той баг салону, який заборонено повторювати: якщо
      // під час відкритого акту прийшла приймання (+N), а рядок порахували РАНІШЕ за приймання,
      // абсолютний SET стер би щойно прийняте. Тому знахідку інвентаризації (correction)
      // НАКЛАДАЄМО ЗВЕРХУ на ПОТОЧНИЙ (на момент закриття) залишок — так само, як зафіксовано
      // виправлення бага салону в routes/inventory.js (diff_qty додається до current, не SET).
      const correction = counted - expected;
      if (correction === 0) continue; // підрахунок співпав з очікуваним на момент внесення — виправляти нічого

      const newQty = Math.max(0, currentQty + correction); // CHECK(qty>=0) на warehouse_stock
      let avgCost;
      if (st) {
        avgCost = Number(st.avg_cost) || 0; // avg_cost НЕ міняємо, лише qty
        await client.query(
          `UPDATE warehouse_stock SET qty=$2, updated_at=NOW() WHERE variant_id=$1 AND warehouse_id='store'`,
          [line.variant_id, newQty]);
      } else {
        avgCost = vinfo ? (Number(vinfo.wholesale) || 0) : 0;
        await client.query(
          `INSERT INTO warehouse_stock (variant_id, warehouse_id, qty, avg_cost) VALUES ($1,'store',$2,$3)`,
          [line.variant_id, newQty, avgCost]);
      }
      const appliedDelta = newQty - currentQty; // фактично застосована зміна (могла бути обрізана GREATEST(0,...))
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:inventory_close',$3,'Інвентаризація складу магазину','store')`,
        [line.variant_id, appliedDelta, id]);

      discrepancies.push({
        variant_id: line.variant_id,
        product_name: vinfo ? vinfo.product_name : null,
        volume: vinfo ? vinfo.volume : null,
        was: currentQty,       // живий залишок на момент закриття, не застарілий знімок
        actual: counted,
        delta: correction,     // розходження, знайдене підрахунком
        value: Math.round(correction * avgCost * 100) / 100
      });
    }

    await client.query(`UPDATE store_inventory_acts SET status='closed', closed_at=NOW() WHERE id=$1`, [id]);
    await client.query('COMMIT');
    res.json({ ok: true, positions_counted: lines.length, discrepancies });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

// ── скасування без застосування ──────────────────────────
router.post('/inventory/acts/:id/cancel', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const r = await client.query(
      `UPDATE store_inventory_acts SET status='cancelled' WHERE id=$1 AND status='open' RETURNING id`,
      [Number(req.params.id)]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Акт не знайдено або вже не відкритий' }); }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.user ? 400 : 500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
