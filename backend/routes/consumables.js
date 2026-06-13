/* Расходники на услугу (SAL-08): какие товары и сколько уходит на одно выполнение */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// плоский список вариантов товаров для пикера расходников
router.get('/_variants', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const vals = [];
    let where = 'pv.active=TRUE';
    if (q) { vals.push('%' + q + '%'); where += ` AND (p.name ILIKE $1 OR pv.sku ILIKE $1)`; }
    const r = await pool.query(
      `SELECT pv.id, p.name AS product_name, pv.volume, pv.sku, pv.stock_qty
         FROM product_variants pv
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE ${where}
        ORDER BY p.name LIMIT 200`,
      vals
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// список расходников услуги (с названиями товаров и остатком)
router.get('/:serviceId', async (req, res) => {
  try {
    const sid = Number(req.params.serviceId);
    const r = await pool.query(
      `SELECT sc.id, sc.variant_id, sc.qty_per_use,
              p.name AS product_name, pv.volume, pv.sku, pv.stock_qty
         FROM service_consumables sc
         JOIN product_variants pv ON pv.id = sc.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE sc.service_id=$1
        ORDER BY p.name`,
      [sid]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// добавить/обновить расходник услуги
router.post('/:serviceId', requirePerm('settings.write'), async (req, res) => {
  try {
    const sid = Number(req.params.serviceId);
    const { variant_id, qty_per_use } = req.body || {};
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });
    const qty = Number(qty_per_use) > 0 ? Number(qty_per_use) : 1;
    const r = await pool.query(
      `INSERT INTO service_consumables (service_id, variant_id, qty_per_use)
       VALUES ($1,$2,$3)
       ON CONFLICT (service_id, variant_id) DO UPDATE SET qty_per_use=EXCLUDED.qty_per_use
       RETURNING *`,
      [sid, Number(variant_id), qty]
    );
    await logAction({ user: req.user, action: 'consumable.set', entity: 'service', entity_id: sid, meta: { variant_id, qty } });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:serviceId/:variantId', requirePerm('settings.write'), async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM service_consumables WHERE service_id=$1 AND variant_id=$2`,
      [Number(req.params.serviceId), Number(req.params.variantId)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
