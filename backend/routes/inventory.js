/* Inventory audits: акты пересчёта, фиксация расхождений, авто-корректировка остатков
   Подключается как /api/inventory */
const express = require('express');
const { Pool } = require('pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// POST /api/inventory/audits — создать акт + наполнить позициями по scope
router.post('/audits', requirePerm('stock.write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { branch_id, scope, scope_filter, notes } = req.body || {};
    const scopeVal = scope || 'full';

    await client.query('BEGIN');
    const a = await client.query(
      `INSERT INTO inventory_audits (branch_id, status, started_by, scope, scope_filter, notes)
       VALUES ($1,'in_progress',$2,$3,$4,$5) RETURNING id`,
      [branch_id || null, req.user?.id || null, scopeVal, scope_filter ? JSON.stringify(scope_filter) : null, notes || null]
    );
    const auditId = a.rows[0].id;

    // Заполнение позиций — все товары или по фильтру
    let where = '1=1';
    const params = [];
    if (scopeVal === 'category' && scope_filter?.category_id) {
      params.push(scope_filter.category_id);
      where = `p.category_id = $${params.length}`;
    } else if (scopeVal === 'brand' && scope_filter?.brand_id) {
      params.push(scope_filter.brand_id);
      where = `p.brand_id = $${params.length}`;
    } else if (scopeVal === 'spot' && Array.isArray(scope_filter?.variant_ids)) {
      params.push(scope_filter.variant_ids);
      where = `v.id = ANY($${params.length}::int[])`;
    }

    const items = await client.query(
      `SELECT v.id AS variant_id, p.name AS product_name, v.sku, COALESCE(v.stock,0) AS expected_qty,
              COALESCE(v.cost,0) AS cost
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE ${where}`,
      params
    );

    for (const it of items.rows) {
      await client.query(
        `INSERT INTO inventory_audit_items (audit_id, variant_id, product_name, sku, expected_qty, cost_per_unit)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [auditId, it.variant_id, it.product_name, it.sku, it.expected_qty, it.cost]
      );
    }
    await client.query(`UPDATE inventory_audits SET total_items=$1 WHERE id=$2`, [items.rows.length, auditId]);
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'inventory.start', entity: 'audit', entity_id: auditId, meta: { scope: scopeVal, items: items.rows.length } });
    res.json({ ok: true, audit_id: auditId, items: items.rows.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /api/inventory/audits — список
router.get('/audits', requirePerm('stock.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM inventory_audit_items i WHERE i.audit_id=a.id AND i.actual_qty IS NOT NULL)::int AS counted,
              (SELECT COUNT(*) FROM inventory_audit_items i WHERE i.audit_id=a.id AND i.diff_qty <> 0)::int AS discrepancies
         FROM inventory_audits a
        ORDER BY a.started_at DESC LIMIT 50`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory/audits/:id — детали + позиции
router.get('/audits/:id', requirePerm('stock.read'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const a = await pool.query(`SELECT * FROM inventory_audits WHERE id=$1`, [id]);
    if (!a.rows[0]) return res.status(404).json({ error: 'not-found' });
    const items = await pool.query(
      `SELECT * FROM inventory_audit_items WHERE audit_id=$1 ORDER BY product_name, sku`, [id]
    );
    res.json({ audit: a.rows[0], items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/inventory/items/:id — внести факт по одной позиции
router.patch('/items/:id', requirePerm('stock.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { actual_qty, reason, notes } = req.body || {};
    if (actual_qty == null) return res.status(400).json({ error: 'actual_qty required' });
    const it = await pool.query(`SELECT cost_per_unit, expected_qty FROM inventory_audit_items WHERE id=$1`, [id]);
    if (!it.rows[0]) return res.status(404).json({ error: 'not-found' });
    const diffVal = (Number(actual_qty) - Number(it.rows[0].expected_qty)) * Number(it.rows[0].cost_per_unit || 0);
    await pool.query(
      `UPDATE inventory_audit_items
          SET actual_qty=$1, reason=$2, notes=$3, diff_value=$4, counted_at=NOW(), counted_by=$5
        WHERE id=$6`,
      [actual_qty, reason || null, notes || null, diffVal, req.user?.id || null, id]
    );
    res.json({ ok: true, diff_value: diffVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/inventory/audits/:id/complete — закрыть акт + применить корректировки
router.post('/audits/:id/complete', requirePerm('stock.write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');
    const a = await client.query(`SELECT * FROM inventory_audits WHERE id=$1 FOR UPDATE`, [id]);
    if (!a.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (a.rows[0].status === 'completed') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'already-completed' }); }

    // Все посчитанные позиции с расхождением → корректировка остатков + лог
    const diffs = await client.query(
      `SELECT * FROM inventory_audit_items WHERE audit_id=$1 AND actual_qty IS NOT NULL AND diff_qty <> 0`,
      [id]
    );

    let totalDiff = 0;
    for (const row of diffs.rows) {
      await client.query(`UPDATE product_variants SET stock=$1 WHERE id=$2`, [row.actual_qty, row.variant_id]);
      // лог движения
      await client.query(
        `INSERT INTO stock_movements (variant_id, movement_type, qty_change, cost_per_unit, reason, created_at)
         VALUES ($1,'audit_adjust',$2,$3,$4,NOW())`,
        [row.variant_id, row.diff_qty, row.cost_per_unit, row.reason || 'inventory_audit']
      ).catch(()=>{});
      totalDiff += Number(row.diff_value || 0);
    }

    await client.query(
      `UPDATE inventory_audits
          SET status='completed', completed_at=NOW(), completed_by=$1, total_diff=$2
        WHERE id=$3`,
      [req.user?.id || null, totalDiff, id]
    );

    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'inventory.complete', entity: 'audit', entity_id: id, meta: { adjusted: diffs.rows.length, total_diff: totalDiff } });
    res.json({ ok: true, adjusted: diffs.rows.length, total_diff: totalDiff });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// DELETE /api/inventory/audits/:id — отменить незавершённый
router.delete('/audits/:id', requirePerm('stock.write'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE inventory_audits SET status='cancelled' WHERE id=$1 AND status<>'completed' RETURNING id`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'cannot-cancel' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
