/* Расходники на услугу (SAL-08): какие товары и сколько уходит на одно выполнение */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// плоский список вариантов товаров для пикера расходников
router.get('/_variants', requirePerm(), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const vals = [];
    let where = 'pv.active=TRUE';
    if (q) { vals.push('%' + q + '%'); where += ` AND (p.name ILIKE $1 OR pv.sku ILIKE $1 OR pv.volume ILIKE $1 OR (p.name || ' ' || pv.volume) ILIKE $1)`; }
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

// Якщо візит ВЖЕ оплачений — зміна матеріалів одразу оновлює касу (операція sale_product).
// Інакше адмін дописує маску/шампунь після оплати: у чеку видно, а грошей у касі нема
// (кейс Босса 05.07: маска ENVIE 780 грн і шампунь не потрапили в касу дня).
// Формула чека = та сама, що в GET-списку матеріалів: фарба за грам АБО будь-який
// матеріал з роздрібною ціною. Знижки заднім числом не перераховуються.
async function syncPaidMaterials(aid) {
  // ТРАНЗАКЦІЯ + FOR UPDATE: два паралельні виклики (два адміни правлять матеріали)
  // раніше могли вставити ДВІ sale_product операції або загубити оновлення (аудит 06.07).
  // applyTenant — обовʼязково: ручний client поза pool-обгорткою не отримує RLS-контекст.
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const ops = await client.query(
      `SELECT id, category, method, master_id, created_at FROM cash_operations
        WHERE type='in' AND ref_type='appointment' AND ref_id=$1 ORDER BY id FOR UPDATE`, [aid]);
    if (!ops.rows.length) { await client.query('ROLLBACK'); return null; } // не оплачено — каса не чіпається
    const mat = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN p.price_per_gram IS NOT NULL THEN ROUND(am.qty_used * p.price_per_gram, 2)
                                WHEN pv.price IS NOT NULL      THEN ROUND(am.qty_used * pv.price, 2)
                                ELSE 0 END),0)::float AS total
         FROM appointment_materials am
         JOIN product_variants pv ON pv.id = am.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE am.appointment_id=$1`, [aid]);
    const total = Math.round((Number(mat.rows[0] && mat.rows[0].total) || 0) * 100) / 100;
    const prod = ops.rows.find(o => o.category === 'sale_product');
    if (prod) {
      if (total > 0) await client.query(`UPDATE cash_operations SET amount=$2 WHERE id=$1`, [prod.id, total]);
      else await client.query(`DELETE FROM cash_operations WHERE id=$1`, [prod.id]);
    } else if (total > 0) {
      const svc = ops.rows.find(o => o.category === 'sale_service') || ops.rows[0];
      const sn = await client.query(
        `SELECT COALESCE(s.name, 'візит #' || a.id::text) AS n
           FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.id=$1`, [aid]);
      await client.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, created_at)
         VALUES (NULL,'in','sale_product',$1,$2,'appointment',$3,$4,$5,$6)
         ON CONFLICT (tenant_id, ref_type, ref_id, method, category) WHERE type='in' AND ref_type='appointment' DO NOTHING`,
        [total, (svc && svc.method) || 'cash', aid, (svc && svc.master_id) || null,
         'Матеріали/товари до візиту: ' + sn.rows[0].n, (svc && svc.created_at) || null]);
    }
    await client.query('COMMIT');
    return total;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[consumables] paid-materials sync:', e.message); return null;
  } finally { client.release(); }
}

// ── Матеріали візиту (заметка #105): фактичний розхід товарів на запис ──
// ВАЖЛИВО: ці роути оголошено ДО параметричного /:serviceId, інакше Express
// зʼїсть "appointment" як serviceId і нові ендпоінти ніколи не спрацюють.

// список матеріалів запису (з назвами товарів і залишком на складі)
router.get('/appointment/:apptId', requirePerm(), async (req, res) => {
  try {
    const aid = Number(req.params.apptId);
    if (!Number.isFinite(aid) || aid <= 0) return res.status(400).json({ error: 'bad-appointment-id' });
    const r = await pool.query(
      `SELECT am.id, am.variant_id, am.qty_used, am.note, am.billable,
              am.seller_master_id, sm.name AS seller_name,
              p.name AS product_name, pv.volume, pv.sku, pv.stock_qty, pv.price,
              p.price_per_gram,
              CASE WHEN p.price_per_gram IS NOT NULL THEN ROUND(am.qty_used * p.price_per_gram, 2)
                   WHEN pv.price IS NOT NULL      THEN ROUND(am.qty_used * pv.price, 2)
                   END AS line_total -- будь-який матеріал з ціною йде в чек (вимога Босса 04.07)
         FROM appointment_materials am
         JOIN product_variants pv ON pv.id = am.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         LEFT JOIN masters sm ON sm.id = am.seller_master_id
        WHERE am.appointment_id=$1
        ORDER BY p.name`,
      [aid]
    );
    const w = await pool.query(`SELECT stock_written_off FROM appointments WHERE id=$1`, [aid]);
    const billable = r.rows.reduce((a, x) => a + (Number(x.line_total) || 0), 0);
    res.json({
      items: r.rows, count: r.rows.length,
      billable_total: Math.round(billable * 100) / 100, // до оплати клієнтом за матеріали
      stock_written_off: !!(w.rows[0] && w.rows[0].stock_written_off),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// додати/оновити матеріал запису (upsert по UNIQUE(appointment_id, variant_id))
router.post('/appointment/:apptId', requirePerm('stock.write'), async (req, res) => {
  try {
    const aid = Number(req.params.apptId);
    if (!Number.isFinite(aid) || aid <= 0) return res.status(400).json({ error: 'bad-appointment-id' });
    const { variant_id, qty_used, note, billable, seller_master_id } = req.body || {};
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });
    // qty<=0 запрещено: отрицательное "списание" увеличило бы склад
    const qty = qty_used == null ? 1 : Number(qty_used);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_used must be > 0' });
    const bill = billable === true || billable === 'true' || billable === 1;
    // Продавець банки (для % з продажу): NULL = майстер візиту. undefined = не чіпати при upsert.
    const seller = seller_master_id === undefined ? undefined
      : (seller_master_id === null || seller_master_id === '' ? null : Number(seller_master_id));
    const a = await pool.query(`SELECT id FROM appointments WHERE id=$1`, [aid]);
    if (!a.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    const r = await pool.query(
      `INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, note, billable, created_by, seller_master_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (appointment_id, variant_id)
       DO UPDATE SET qty_used=EXCLUDED.qty_used, note=COALESCE(EXCLUDED.note, appointment_materials.note),
                     billable=EXCLUDED.billable,
                     seller_master_id=CASE WHEN $8 THEN EXCLUDED.seller_master_id ELSE appointment_materials.seller_master_id END
       RETURNING *`,
      [aid, Number(variant_id), qty, note || null, bill, (req.user && req.user.display_name) || null,
       seller === undefined ? null : seller, seller !== undefined]
    );
    await logAction({ user: req.user, action: 'material.set', entity: 'appointment', entity_id: aid, meta: { variant_id, qty } });
    const cashSynced = await syncPaidMaterials(aid); // оплачений візит → каса відразу актуальна
    res.json({ ok: true, item: r.rows[0], cash_synced: cashSynced });
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
    const cashSynced = await syncPaidMaterials(aid);
    res.json({ ok: true, added: r.rowCount, cash_synced: cashSynced });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// змінити ПРОДАВЦЯ банки (для % з продажу продукції) — не чіпає кількість/касу.
// Можна міняти і після оплати: впливає лише на базу комісії продавця в ЗП.
router.patch('/appointment/:apptId/:variantId/seller', requirePerm('stock.write'), async (req, res) => {
  try {
    const sid = req.body && req.body.seller_master_id != null && req.body.seller_master_id !== ''
      ? Number(req.body.seller_master_id) : null;
    const r = await pool.query(
      `UPDATE appointment_materials SET seller_master_id=$3
        WHERE appointment_id=$1 AND variant_id=$2 RETURNING id, seller_master_id`,
      [Number(req.params.apptId), Number(req.params.variantId), sid]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'material.seller', entity: 'appointment',
      entity_id: Number(req.params.apptId), meta: { variant_id: Number(req.params.variantId), seller_master_id: sid } });
    res.json({ ok: true, seller_master_id: r.rows[0].seller_master_id });
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
    const cashSynced = await syncPaidMaterials(Number(req.params.apptId));
    res.json({ ok: true, cash_synced: cashSynced });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// список расходников услуги (с названиями товаров и остатком)
router.get('/:serviceId', requirePerm(), async (req, res) => {
  try {
    const sid = Number(req.params.serviceId);
    const r = await pool.query(
      `SELECT sc.id, sc.variant_id, sc.qty_per_use,
              p.name AS product_name, pv.volume, pv.sku, pv.stock_qty, pv.price, pv.wholesale
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
