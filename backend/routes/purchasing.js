/* ═══════════════════════════════════════════════════════
   SLS-06 — Закупки (Purchasing). /api/purchasing
   Цикл: потребность → заказ → согласование → отправка →
   приёмка на склад (через stock_receipts) → закрытие.
   Интеграция: suppliers(005), products(001), stock_receipts(005).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const STATUSES = ['draft','pending_approval','approved','rejected','ordered','in_transit','partially_received','received','closed','cancelled'];

async function genPoNumber(client) {
  const year = new Date().getFullYear();
  const r = await client.query(
    `SELECT COUNT(*)::int n FROM purchase_orders WHERE po_number LIKE $1`, [`PO-${year}-%`]);
  return `PO-${year}-${String(r.rows[0].n + 1).padStart(4, '0')}`;
}

async function recomputeTotal(client, poId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(total_price),0) s FROM purchase_order_items WHERE purchase_order_id=$1`, [poId]);
  await client.query(
    `UPDATE purchase_orders SET total_amount = $2 - COALESCE(discount_amount,0), updated_at=NOW() WHERE id=$1`,
    [poId, r.rows[0].s]);
}

// ─────── ПОТРЕБНОСТЬ В ЗАКУПКЕ ───────
// Товары, у которых остаток <= min_stock. Приоритет: critical (0) / normal.
router.get('/needs', requirePerm('stock.read'), async (req, res) => {
  try {
    const { priority } = req.query;
    const r = await getPool().query(
      `SELECT p.id AS product_id, p.name,
              COALESCE(v.qty, COALESCE(p.stock,0)) AS current_stock,
              p.min_stock, p.max_stock,
              GREATEST(COALESCE(p.max_stock, p.min_stock*2, 0) - COALESCE(v.qty, COALESCE(p.stock,0)), 0) AS suggested_qty,
              (SELECT COUNT(*)::int FROM product_variants pv2 WHERE pv2.product_id=p.id AND pv2.active IS NOT FALSE) AS variants_count,
              ar.preferred_supplier_id, s.name AS supplier_name
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(COALESCE(stock_qty,0)) AS qty
                    FROM product_variants WHERE active IS NOT FALSE GROUP BY product_id) v ON v.product_id = p.id
       LEFT JOIN auto_purchase_rules ar ON ar.product_id = p.id AND ar.active
       LEFT JOIN suppliers s ON s.id = ar.preferred_supplier_id
       WHERE p.active AND p.min_stock IS NOT NULL AND COALESCE(v.qty, COALESCE(p.stock,0)) <= p.min_stock
       ORDER BY (COALESCE(v.qty, COALESCE(p.stock,0)) = 0) DESC, p.name`);
    let items = r.rows.map(x => ({ ...x, priority: Number(x.current_stock) <= 0 ? 'critical' : 'normal' }));
    if (priority) items = items.filter(x => x.priority === priority);
    res.json({ items, count: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────── ЗАКАЗЫ ───────
router.get('/orders', requirePerm('stock.read'), async (req, res) => {
  try {
    const { status, supplier_id, from, to, limit = 50, offset = 0 } = req.query;
    const cond = [], args = [];
    if (status) { args.push(status); cond.push(`po.status=$${args.length}`); }
    if (supplier_id) { args.push(supplier_id); cond.push(`po.supplier_id=$${args.length}`); }
    if (from) { args.push(from); cond.push(`po.created_at>=$${args.length}`); }
    if (to) { args.push(to); cond.push(`po.created_at<=$${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(Math.min(+limit, 200)); args.push(+offset);
    const r = await getPool().query(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*)::int FROM purchase_order_items WHERE purchase_order_id=po.id) AS items_count
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id
       ${where} ORDER BY po.created_at DESC LIMIT $${args.length-1} OFFSET $${args.length}`, args);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/orders/:id', requirePerm('stock.read'), async (req, res) => {
  try {
    const pool = getPool();
    const po = await pool.query(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=$1`, [req.params.id]);
    if (!po.rowCount) return res.status(404).json({ error: 'not-found' });
    const items = await pool.query(`SELECT * FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY id`, [req.params.id]);
    const approvals = await pool.query(`SELECT * FROM purchase_approvals WHERE purchase_order_id=$1 ORDER BY id`, [req.params.id]);
    const receipts = await pool.query(`SELECT * FROM purchase_receipts WHERE purchase_order_id=$1 ORDER BY id`, [req.params.id]);
    res.json({ order: po.rows[0], items: items.rows, approvals: approvals.rows, receipts: receipts.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/orders', requirePerm('stock.manage'), async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const { supplier_id, items, expected_delivery, notes, discount_amount = 0, auto_generated = false } = req.body || {};
    if (!Array.isArray(items) || !items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'items-required' }); }
    const po_number = await genPoNumber(client);
    const po = await client.query(
      `INSERT INTO purchase_orders(po_number, supplier_id, status, discount_amount, expected_delivery, notes, created_by, auto_generated)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7) RETURNING *`,
      [po_number, supplier_id || null, discount_amount, expected_delivery || null, notes || null, req.user?.id || null, auto_generated]);
    const poId = po.rows[0].id;
    for (const it of items) {
      const qty = parseFloat(it.quantity), price = parseFloat(it.unit_price);
      await client.query(
        `INSERT INTO purchase_order_items(purchase_order_id, product_id, variant_id, product_name, quantity_ordered, unit_price, total_price, supplier_sku, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [poId, it.product_id || null, it.variant_id || null, it.product_name || null, qty, price, qty * price, it.supplier_sku || null, it.notes || null]);
    }
    await recomputeTotal(client, poId);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'purchase.order.create', entity: 'purchase_order', entity_id: poId, ip: req.ip, meta: { po_number } });
    const out = await getPool().query(`SELECT * FROM purchase_orders WHERE id=$1`, [poId]);
    res.json({ ok: true, order: out.rows[0] });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  finally { client.release(); }
});

router.patch('/orders/:id', requirePerm('stock.manage'), async (req, res) => {
  try {
    const cur = await getPool().query(`SELECT status FROM purchase_orders WHERE id=$1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not-found' });
    if (!['draft', 'pending_approval'].includes(cur.rows[0].status)) return res.status(409).json({ error: 'not-editable' });
    const { supplier_id, expected_delivery, notes, discount_amount } = req.body || {};
    const sets = [], args = [];
    if (supplier_id !== undefined) { args.push(supplier_id); sets.push(`supplier_id=$${args.length}`); }
    if (expected_delivery !== undefined) { args.push(expected_delivery); sets.push(`expected_delivery=$${args.length}`); }
    if (notes !== undefined) { args.push(notes); sets.push(`notes=$${args.length}`); }
    if (discount_amount !== undefined) { args.push(discount_amount); sets.push(`discount_amount=$${args.length}`); }
    if (!sets.length) return res.json({ ok: true });
    args.push(req.params.id);
    await getPool().query(`UPDATE purchase_orders SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${args.length}`, args);
    if (discount_amount !== undefined) { const c = await getPool().connect(); try { await c.query('BEGIN'); await applyTenant(c); await recomputeTotal(c, req.params.id); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// draft → pending_approval
router.post('/orders/:id/submit', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await getPool().query(
      `UPDATE purchase_orders SET status='pending_approval', updated_at=NOW() WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-draft' });
    await getPool().query(
      `INSERT INTO purchase_approvals(purchase_order_id, status, level) VALUES ($1,'pending',1)`, [req.params.id]);
    res.json({ ok: true, order: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// approve / reject
router.post('/orders/:id/approve', requirePerm('reports.finance'), async (req, res) => {
  try {
    const pool = getPool();
    const cur = await pool.query(`SELECT status FROM purchase_orders WHERE id=$1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not-found' });
    if (cur.rows[0].status !== 'pending_approval') return res.status(409).json({ error: 'not-pending' });
    await pool.query(
      `UPDATE purchase_orders SET status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id, req.user?.id || null]);
    await pool.query(
      `UPDATE purchase_approvals SET status='approved', comment=$2, decided_at=NOW(), approver_id=$3
       WHERE purchase_order_id=$1 AND status='pending'`, [req.params.id, req.body?.comment || null, req.user?.id || null]);
    logAction({ user: req.user, action: 'purchase.order.approve', entity: 'purchase_order', entity_id: +req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/orders/:id/reject', requirePerm('reports.finance'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE purchase_orders SET status='rejected', updated_at=NOW() WHERE id=$1 AND status='pending_approval' RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-pending' });
    await pool.query(
      `UPDATE purchase_approvals SET status='rejected', comment=$2, decided_at=NOW(), approver_id=$3
       WHERE purchase_order_id=$1 AND status='pending'`, [req.params.id, req.body?.comment || null, req.user?.id || null]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// approved → ordered (отправлен поставщику)
router.post('/orders/:id/send', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await getPool().query(
      `UPDATE purchase_orders SET status='ordered', ordered_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='approved' RETURNING *`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-approved' });
    res.json({ ok: true, order: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Приёмка товара → создаёт stock_receipt и увеличивает products.stock
router.post('/orders/:id/receive', requirePerm('stock.manage'), async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const poId = req.params.id;
    // FOR UPDATE: подвійний клік «Прийняти» створював ДВІ приймання (гонка 04.07.2026,
    // PO-2026-0001 ×2) — тепер друга транзакція чекає першу і бачить статус received → 409
    const po = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [poId]);
    if (!po.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (!['ordered', 'in_transit', 'partially_received', 'approved'].includes(po.rows[0].status)) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'not-receivable', message: 'Заказ вже прийнято або він не в тому статусі' });
    }
    const { items, discrepancy_notes, discrepancy_photos } = req.body || {};
    if (!Array.isArray(items) || !items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'items-required' }); }

    // приход на склад (warehouse receipt)
    const poItems = (await client.query(`SELECT * FROM purchase_order_items WHERE purchase_order_id=$1`, [poId])).rows;
    const byId = {}; poItems.forEach(i => byId[i.id] = i);
    let recvTotal = 0;
    const recItems = [];
    for (const it of items) {
      const poi = byId[it.po_item_id];
      if (!poi) continue;
      // стеля: не можна прийняти більше, ніж лишилось по позиції (захист від повторів)
      const remaining = Math.max(parseFloat(poi.quantity_ordered) - parseFloat(poi.quantity_received || 0), 0);
      const q = Math.min(parseFloat(it.quantity_received || 0), remaining);
      if (q <= 0 && !(parseFloat(it.quantity_defective || 0) > 0)) continue;
      recvTotal += q * parseFloat(poi.unit_price);
      recItems.push({ poi, q, def: parseFloat(it.quantity_defective || 0), wrong: parseFloat(it.quantity_wrong || 0), notes: it.notes });
    }
    const sr = await client.query(
      `INSERT INTO stock_receipts(supplier_id, invoice_no, total_cost, notes)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [po.rows[0].supplier_id, po.rows[0].po_number, recvTotal, discrepancy_notes || null]);
    const stockReceiptId = sr.rows[0].id;

    const unassigned = []; // товари з кількома варіантами (тони) — прихід не розподілено
    const hasDisc = recItems.some(r => r.def > 0 || r.wrong > 0) || !!discrepancy_notes;
    const pr = await client.query(
      `INSERT INTO purchase_receipts(purchase_order_id, received_by, has_discrepancy, discrepancy_notes, discrepancy_photos, stock_receipt_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [poId, req.user?.id || null, hasDisc, discrepancy_notes || null, discrepancy_photos || null, stockReceiptId]);
    const prId = pr.rows[0].id;

    for (const r of recItems) {
      await client.query(
        `INSERT INTO purchase_receipt_items(purchase_receipt_id, po_item_id, quantity_received, quantity_defective, quantity_wrong, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`, [prId, r.poi.id, r.q, r.def, r.wrong, r.notes || null]);
      // обновляем полученное кол-во в позиции заказа
      await client.query(
        `UPDATE purchase_order_items SET quantity_received = COALESCE(quantity_received,0) + $2 WHERE id=$1`, [r.poi.id, r.q]);
      // приход на склад (только годный товар)
      const good = r.q - r.def - r.wrong;
      if (r.poi.product_id && good > 0) {
        await client.query(
          `INSERT INTO stock_receipt_items(receipt_id, product_id, product_name, qty, unit_cost)
           VALUES ($1,$2,$3,$4,$5)`, [stockReceiptId, r.poi.product_id, r.poi.product_name, good, r.poi.unit_price]);
        await client.query(`UPDATE products SET stock = COALESCE(stock,0) + $1 WHERE id=$2`, [good, r.poi.product_id]);
        // Аудит #25 + #10: реальный остаток для продаж/списаний/инвентаризации
        // хранится в product_variants.stock_qty, а не в products.stock. Пополняем вариант:
        //   • позиция закупки указывает variant_id → пополняем именно его (точно, #10);
        //   • variant_id не задан, 1 активный вариант → пополняем единственный (83% товаров);
        //   • variant_id не задан, >1 вариантов → не угадываем, предупреждение.
        const cost = Number(r.poi.unit_price) > 0 ? Number(r.poi.unit_price) : null; // ціна приходу → нова собівартість
        let targetVariant = null;
        if (r.poi.variant_id) {
          // целевой вариант указан в заказе — проверяем что он принадлежит товару
          const vchk = (await client.query(
            `SELECT id FROM product_variants WHERE id=$1 AND product_id=$2`,
            [r.poi.variant_id, r.poi.product_id])).rows;
          if (vchk.length) {
            targetVariant = r.poi.variant_id;
          } else {
            console.warn(`[purchasing] variant_id ${r.poi.variant_id} не принадлежит товару ${r.poi.product_id} — приход ${good} не распределён`);
          }
        } else {
          const vrows = (await client.query(
            `SELECT id FROM product_variants WHERE product_id=$1 AND active IS NOT FALSE`,
            [r.poi.product_id])).rows;
          if (vrows.length === 1) {
            targetVariant = vrows[0].id;
          } else if (vrows.length > 1) {
            unassigned.push(r.poi.product_name);
            console.warn(`[purchasing] товар ${r.poi.product_id} имеет ${vrows.length} вариантов без variant_id в позиции — приход ${good} не распределён (выберите вариант в форме закупки)`);
          }
        }
        // ГРАМОВИЙ товар (price_per_gram, unit_ml > 1): кількість у замовленні — ПЛЯШКИ,
        // а склад ведеться в мл/г → приход = good × unit_ml (як у stock-import).
        // Роздрібні банки: склад у ШТУКАХ (18.07) — good як є.
        if (targetVariant) {
          const vi = (await client.query(
            `SELECT pv.unit_ml::float AS unit_ml, p.price_per_gram
               FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id=$1`, [targetVariant])).rows[0] || {};
          const um = Number(vi.unit_ml) || 0;
          const delta = (vi.price_per_gram != null && um > 1) ? good * um : good;
          await client.query(
            `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $1, wholesale = COALESCE($3, wholesale) WHERE id=$2`,
            [delta, targetVariant, cost]);
          // Рух складу прив'язуємо до variant_id (а не product_id) — для трасування й COGS.
          await client.query(
            `INSERT INTO stock_movements(variant_id, product_id, delta, reason, notes) VALUES ($1,$2,$3,'purchase',$4)`,
            [targetVariant, r.poi.product_id, delta, `PO ${po.rows[0].po_number}`]);
        }
      }
    }

    // статус заказа: полностью получен или частично
    const after = (await client.query(`SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id=$1`, [poId])).rows;
    const allReceived = after.every(i => Number(i.quantity_received) >= Number(i.quantity_ordered));
    const newStatus = allReceived ? 'received' : 'partially_received';
    await client.query(
      `UPDATE purchase_orders SET status=$2, received_at=CASE WHEN $2='received' THEN NOW() ELSE received_at END,
       actual_delivery=CURRENT_DATE, updated_at=NOW() WHERE id=$1`, [poId, newStatus]);

    await client.query('COMMIT');
    logAction({ user: req.user, action: 'purchase.receive', entity: 'purchase_order', entity_id: +poId, ip: req.ip, meta: { stockReceiptId, status: newStatus } });
    res.json({ ok: true, receipt_id: prId, stock_receipt_id: stockReceiptId, status: newStatus, has_discrepancy: hasDisc, unassigned_count: unassigned.length, unassigned: unassigned.slice(0, 10) });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  finally { client.release(); }
});

router.post('/orders/:id/close', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await getPool().query(
      `UPDATE purchase_orders SET status='closed', updated_at=NOW() WHERE id=$1 AND status IN ('received','partially_received') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-received' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/orders/:id/cancel', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await getPool().query(
      `UPDATE purchase_orders SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status IN ('draft','pending_approval','approved','rejected') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-cancellable' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/orders/:id', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await getPool().query(`DELETE FROM purchase_orders WHERE id=$1 AND status IN ('draft','cancelled','rejected') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-deletable' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────── АНАЛИТИКА ───────
router.get('/analytics', requirePerm('stock.read'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const cond = [`status NOT IN ('draft','cancelled','rejected')`], args = [];
    if (from) { args.push(from); cond.push(`created_at>=$${args.length}`); }
    if (to) { args.push(to); cond.push(`created_at<=$${args.length}`); }
    const where = 'WHERE ' + cond.join(' AND ');
    const pool = getPool();
    const tot = await pool.query(
      `SELECT COUNT(*)::int orders_count, COALESCE(SUM(total_amount),0) total_spent,
              AVG(CASE WHEN actual_delivery IS NOT NULL AND ordered_at IS NOT NULL
                   THEN actual_delivery - ordered_at::date END) avg_delivery_days
       FROM purchase_orders ${where}`, args);
    const topProducts = await pool.query(
      `SELECT poi.product_name, SUM(poi.quantity_ordered) qty, SUM(poi.total_price) amount
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id ${where.replace(/created_at/g,'po.created_at').replace(/status/,'po.status')}
       GROUP BY poi.product_name ORDER BY amount DESC LIMIT 10`, args);
    const topSuppliers = await pool.query(
      `SELECT s.name, COUNT(*)::int orders, SUM(po.total_amount) amount
       FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id ${where.replace(/status/,'po.status').replace(/created_at/g,'po.created_at')}
       GROUP BY s.name ORDER BY amount DESC LIMIT 10`, args);
    const disc = await pool.query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE has_discrepancy)::int with_disc FROM purchase_receipts`);
    const d = disc.rows[0];
    res.json({
      ...tot.rows[0],
      avg_delivery_days: tot.rows[0].avg_delivery_days ? Math.round(tot.rows[0].avg_delivery_days) : null,
      top_products: topProducts.rows,
      top_suppliers: topSuppliers.rows,
      discrepancy_rate: d.total ? Math.round((d.with_disc / d.total) * 100) : 0,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────── ПРАВИЛА АВТОЗАКУПКИ ───────
router.get('/auto-rules', requirePerm('stock.read'), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT ar.*, p.name AS product_name, s.name AS supplier_name
       FROM auto_purchase_rules ar
       LEFT JOIN products p ON p.id=ar.product_id
       LEFT JOIN suppliers s ON s.id=ar.preferred_supplier_id ORDER BY ar.id DESC`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/auto-rules', requirePerm('stock.manage'), async (req, res) => {
  try {
    const { product_id, preferred_supplier_id, selection_strategy = 'preferred', max_auto_amount, auto_approve = false } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product-required' });
    const r = await getPool().query(
      `INSERT INTO auto_purchase_rules(product_id, preferred_supplier_id, selection_strategy, max_auto_amount, auto_approve)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_id) DO UPDATE SET preferred_supplier_id=EXCLUDED.preferred_supplier_id,
         selection_strategy=EXCLUDED.selection_strategy, max_auto_amount=EXCLUDED.max_auto_amount,
         auto_approve=EXCLUDED.auto_approve, active=TRUE, updated_at=NOW() RETURNING *`,
      [product_id, preferred_supplier_id || null, selection_strategy, max_auto_amount || null, auto_approve]);
    res.json({ ok: true, rule: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/auto-rules/:id', requirePerm('stock.manage'), async (req, res) => {
  try {
    const { preferred_supplier_id, selection_strategy, max_auto_amount, auto_approve, active } = req.body || {};
    const sets = [], args = [];
    for (const [k, v] of Object.entries({ preferred_supplier_id, selection_strategy, max_auto_amount, auto_approve, active })) {
      if (v !== undefined) { args.push(v); sets.push(`${k}=$${args.length}`); }
    }
    if (!sets.length) return res.json({ ok: true });
    args.push(req.params.id);
    await getPool().query(`UPDATE auto_purchase_rules SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${args.length}`, args);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/auto-rules/:id', requirePerm('stock.manage'), async (req, res) => {
  try {
    await getPool().query(`DELETE FROM auto_purchase_rules WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Прогон автозакупки: по правилам создаёт draft-заказы для товаров ниже минимума
async function runAutoPurchase() {
  const pool = getPool();
  // Кандидати = ВСІ активні товари нижче мінімуму (та сама логіка, що в /needs).
  // auto_purchase_rules — лише додаткове налаштування (бажаний постачальник),
  // НЕ фільтр: раніше без жодного правила кнопка завжди давала «0 кандидатів» (заметка #125).
  const due = await pool.query(
    `SELECT p.id AS product_id, p.name,
            COALESCE(v.qty, COALESCE(p.stock,0)) AS stock, p.min_stock, p.max_stock,
            ar.preferred_supplier_id, ar.max_auto_amount, ar.auto_approve
     FROM products p
     LEFT JOIN (SELECT product_id, SUM(COALESCE(stock_qty,0)) AS qty
                  FROM product_variants WHERE active IS NOT FALSE GROUP BY product_id) v ON v.product_id = p.id
     LEFT JOIN auto_purchase_rules ar ON ar.product_id = p.id AND ar.active
     WHERE p.active AND p.min_stock IS NOT NULL AND COALESCE(v.qty, COALESCE(p.stock,0)) <= p.min_stock
       AND (SELECT COUNT(*) FROM product_variants pv2 WHERE pv2.product_id=p.id AND pv2.active IS NOT FALSE) <= 1`);
  // мультиваріантні товари (фарби у тонах) в авто-заказ НЕ потрапляють: приймання не знає,
  // який тон приїхав (кейс 04.07 — 47 «незарахованих» позицій). Їх прихід — Склад → накладна.
  // группируем по поставщику
  const bySupplier = {};
  for (const row of due.rows) {
    // нет ли уже открытого авто-заказа на этот товар
    const exists = await pool.query(
      `SELECT 1 FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id
       WHERE poi.product_id=$1 AND po.auto_generated AND po.status IN ('draft','pending_approval','approved','ordered','in_transit') LIMIT 1`,
      [row.product_id]);
    if (exists.rowCount) continue;
    const sid = row.preferred_supplier_id || 0;
    (bySupplier[sid] = bySupplier[sid] || []).push(row);
  }
  let created = 0;
  for (const [sid, rows] of Object.entries(bySupplier)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const po_number = await genPoNumber(client);
      const po = await client.query(
        `INSERT INTO purchase_orders(po_number, supplier_id, status, notes, auto_generated)
         VALUES ($1,$2,'draft','Автозакупка: остаток ниже минимума',TRUE) RETURNING id`,
        [po_number, sid > 0 ? sid : null]);
      const poId = po.rows[0].id;
      for (const r of rows) {
        const qty = Math.max((Number(r.max_stock) || Number(r.min_stock) * 2 || 0) - Number(r.stock), 1);
        await client.query(
          `INSERT INTO purchase_order_items(purchase_order_id, product_id, product_name, quantity_ordered, unit_price, total_price)
           VALUES ($1,$2,$3,$4,0,0)`, [poId, r.product_id, r.name, qty]);
      }
      await client.query('COMMIT');
      created++;
    } catch (e) { await client.query('ROLLBACK'); console.error('[autopurchase]', e.message); }
    finally { client.release(); }
  }
  return { candidates: due.rowCount, orders_created: created };
}

router.post('/auto-run', requirePerm('stock.manage'), async (req, res) => {
  try { res.json({ ok: true, ...(await runAutoPurchase()) }); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
module.exports.runAutoPurchase = runAutoPurchase;
