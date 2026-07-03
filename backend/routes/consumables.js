/* Расходники на услугу (SAL-08): какие товары и сколько уходит на одно выполнение */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// плоский список вариантов товаров для пикера расходников
router.get('/_variants', requirePerm(), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const vals = [];
    let where = 'pv.active=TRUE';
    if (q) { vals.push('%' + q + '%'); where += ` AND (p.name ILIKE $1 OR pv.sku ILIKE $1)`; }
    const r = await pool.query(
      `SELECT pv.id, p.name AS product_name, pv.volume, pv.sku, pv.stock_qty, pv.price
         FROM product_variants pv
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE ${where}
        ORDER BY p.name LIMIT 200`,
      vals
    );
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Матеріали візиту (заметка #105): фактичний розхід товарів на запис ──
// ВАЖЛИВО: ці роути оголошено ДО параметричного /:serviceId, інакше Express
// зʼїсть "appointment" як serviceId і нові ендпоінти ніколи не спрацюють.

// список матеріалів запису (з назвами товарів і залишком на складі)
router.get('/appointment/:apptId', requirePerm(), async (req, res) => {
  try {
    const aid = Number(req.params.apptId);
    if (!Number.isFinite(aid) || aid <= 0) return res.status(400).json({ error: 'bad-appointment-id' });
    const r = await pool.query(
      `SELECT am.id, am.variant_id, am.qty_used, am.note,
              p.name AS product_name, pv.volume, pv.sku, pv.stock_qty, pv.price
         FROM appointment_materials am
         JOIN product_variants pv ON pv.id = am.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE am.appointment_id=$1
        ORDER BY p.name`,
      [aid]
    );
    const w = await pool.query(`SELECT stock_written_off FROM appointments WHERE id=$1`, [aid]);
    res.json({
      items: r.rows, count: r.rows.length,
      stock_written_off: !!(w.rows[0] && w.rows[0].stock_written_off),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// додати/оновити матеріал запису (upsert по UNIQUE(appointment_id, variant_id))
router.post('/appointment/:apptId', requirePerm('stock.write'), async (req, res) => {
  try {
    const aid = Number(req.params.apptId);
    if (!Number.isFinite(aid) || aid <= 0) return res.status(400).json({ error: 'bad-appointment-id' });
    const { variant_id, qty_used, note } = req.body || {};
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });
    // qty<=0 запрещено: отрицательное "списание" увеличило бы склад
    const qty = qty_used == null ? 1 : Number(qty_used);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_used must be > 0' });
    const a = await pool.query(`SELECT id FROM appointments WHERE id=$1`, [aid]);
    if (!a.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    const r = await pool.query(
      `INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, note, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (appointment_id, variant_id)
       DO UPDATE SET qty_used=EXCLUDED.qty_used, note=COALESCE(EXCLUDED.note, appointment_materials.note)
       RETURNING *`,
      [aid, Number(variant_id), qty, note || null, (req.user && req.user.display_name) || null]
    );
    await logAction({ user: req.user, action: 'material.set', entity: 'appointment', entity_id: aid, meta: { variant_id, qty } });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// заповнити матеріали за нормами service_consumables (усі послуги запису:
// основна послуга + рядки appointment_services), вже додані — пропускаємо
router.post('/appointment/:apptId/prefill', requirePerm('stock.write'), async (req, res) => {
  try {
    const aid = Number(req.params.apptId);
    if (!Number.isFinite(aid) || aid <= 0) return res.status(400).json({ error: 'bad-appointment-id' });
    const a = await pool.query(`SELECT id FROM appointments WHERE id=$1`, [aid]);
    if (!a.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    const r = await pool.query(
      `INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, note, created_by)
       SELECT $1, sc.variant_id, SUM(sc.qty_per_use), 'за нормами', $2
         FROM service_consumables sc
        WHERE sc.service_id IN (
                SELECT service_id FROM appointments WHERE id=$1 AND service_id IS NOT NULL
                UNION
                SELECT service_id FROM appointment_services WHERE appointment_id=$1 AND service_id IS NOT NULL
              )
        GROUP BY sc.variant_id
       ON CONFLICT (appointment_id, variant_id) DO NOTHING
       RETURNING variant_id`,
      [aid, (req.user && req.user.display_name) || null]
    );
    await logAction({ user: req.user, action: 'material.prefill', entity: 'appointment', entity_id: aid, meta: { added: r.rowCount } });
    res.json({ ok: true, added: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// видалити матеріал запису
router.delete('/appointment/:apptId/:variantId', requirePerm('stock.write'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM appointment_materials WHERE appointment_id=$1 AND variant_id=$2`,
      [Number(req.params.apptId), Number(req.params.variantId)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// список расходников услуги (с названиями товаров и остатком)
router.get('/:serviceId', requirePerm(), async (req, res) => {
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// добавить/обновить расходник услуги
router.post('/:serviceId', requirePerm('settings.write'), async (req, res) => {
  try {
    const sid = Number(req.params.serviceId);
    const { variant_id, qty_per_use } = req.body || {};
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });
    // qty<=0 запрещено: отрицательная норма = скрытый приход при списании
    const qty = qty_per_use == null ? 1 : Number(qty_per_use);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_per_use must be > 0' });
    const r = await pool.query(
      `INSERT INTO service_consumables (service_id, variant_id, qty_per_use)
       VALUES ($1,$2,$3)
       ON CONFLICT (service_id, variant_id) DO UPDATE SET qty_per_use=EXCLUDED.qty_per_use
       RETURNING *`,
      [sid, Number(variant_id), qty]
    );
    await logAction({ user: req.user, action: 'consumable.set', entity: 'service', entity_id: sid, meta: { variant_id, qty } });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/:serviceId/:variantId', requirePerm('settings.write'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM service_consumables WHERE service_id=$1 AND variant_id=$2`,
      [Number(req.params.serviceId), Number(req.params.variantId)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
