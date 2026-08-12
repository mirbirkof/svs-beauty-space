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

module.exports = router;
