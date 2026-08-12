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
const { getPool } = require('../db-pg');
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
  const { supplier_name, doc_date, delivery_cost = 0, notes, items } = req.body || {};
  if (!doc_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(doc_date)))
    return res.status(400).json({ error: 'doc_date обовʼязкова (YYYY-MM-DD)' });
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'порожній список позицій' });
  const dc = Number(delivery_cost) || 0;
  if (dc < 0) return res.status(400).json({ error: 'delivery_cost не може бути відʼємною' });
  for (const it of items) {
    if (!it.variant_id || !(Number(it.qty) > 0) || !(Number(it.unit_cost) >= 0))
      return res.status(400).json({ error: 'позиція: потрібні variant_id, qty>0, unit_cost>=0' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const goodsTotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
    const rec = (await client.query(
      `INSERT INTO store_receipts (supplier_name, doc_date, goods_total, delivery_cost, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [supplier_name || null, doc_date, goodsTotal, dc, notes || null,
       (req.user && (req.user.name || req.user.login)) || null])).rows[0];
    for (const it of items) {
      const qty = Number(it.qty), cost = Number(it.unit_cost);
      // landed cost: доля доставки пропорционально стоимости позиции
      const landed = goodsTotal > 0 ? cost * (1 + dc / goodsTotal) : cost;
      await client.query(
        `INSERT INTO store_receipt_items (receipt_id, variant_id, qty, unit_cost, landed_unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [rec.id, it.variant_id, qty, cost, landed]);
      // средневзвешенная себестоимость остатка (все SET считаются от старой строки — порядок безопасен)
      await client.query(
        `INSERT INTO warehouse_stock (variant_id, warehouse_id, qty, avg_cost)
         VALUES ($1,'store',$2,$3)
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET
           avg_cost = CASE WHEN warehouse_stock.qty + EXCLUDED.qty > 0
             THEN (warehouse_stock.qty * warehouse_stock.avg_cost + EXCLUDED.qty * EXCLUDED.avg_cost)
                  / (warehouse_stock.qty + EXCLUDED.qty)
             ELSE EXCLUDED.avg_cost END,
           qty = warehouse_stock.qty + EXCLUDED.qty,
           updated_at = NOW()`,
        [it.variant_id, qty, landed]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:receipt',$3,$4,'store')`,
        [it.variant_id, qty, rec.id,
         `Поставка ${doc_date}${supplier_name ? ' — ' + String(supplier_name).slice(0, 80) : ''}`]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, receipt_id: rec.id, goods_total: Math.round(goodsTotal * 100) / 100, delivery_cost: dc });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── история внутренних продаж ───────────────────────────
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
    await client.query('BEGIN');
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
      const price = Number(st.wholesale != null ? st.wholesale : st.price) || 0; // ОПТ (решение Босса)
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
    await client.query('BEGIN');
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
      const price = it.unit_price != null && Number(it.unit_price) >= 0 ? Number(it.unit_price) : Number(base) || 0;
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
    await client.query('BEGIN');
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
    const online = rev.rows.filter(r => r.channel === 'online');
    res.json({
      days,
      revenue: {
        wholesale: sum(wholesale, 'revenue'),
        retail: sum(retail, 'revenue'),
        online: sum(online, 'revenue'),
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

module.exports = router;
