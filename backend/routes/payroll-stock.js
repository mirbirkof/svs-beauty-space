/* Payroll + Stock operations: схемы ЗП мастеров, начисления, поставки, списания материалов
   Подключается в dikidi-server.js */
const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ═══════════════ PAYROLL SCHEMES ═══════════════ */

// POST /api/payroll/schemes — создать/обновить схему
router.post('/payroll/schemes', async (req, res) => {
  try {
    const { master_id, master_name, scheme_type, percent, fixed_per_day, fixed_per_month, notes } = req.body || {};
    if (!master_id || !scheme_type) return res.status(400).json({ error: 'master_id, scheme_type required' });
    if (!['percent', 'fixed', 'hybrid'].includes(scheme_type)) return res.status(400).json({ error: 'bad scheme_type' });
    // деактивируем старые схемы для этого мастера
    await pool.query(`UPDATE payroll_schemes SET is_active=FALSE WHERE master_id=$1`, [master_id]);
    const r = await pool.query(
      `INSERT INTO payroll_schemes (master_id, master_name, scheme_type, percent, fixed_per_day, fixed_per_month, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id`,
      [master_id, master_name || null, scheme_type, percent || null, fixed_per_day || null, fixed_per_month || null, notes || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/payroll/schemes — все активные
router.get('/payroll/schemes', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM payroll_schemes WHERE is_active=TRUE ORDER BY master_name, master_id`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payroll/calculate — рассчитать ЗП за период
router.post('/payroll/calculate', async (req, res) => {
  try {
    const { master_id, period_start, period_end } = req.body || {};
    if (!master_id || !period_start || !period_end) return res.status(400).json({ error: 'master_id, period_start, period_end required' });

    // 1. найти активную схему
    const scheme = await pool.query(
      `SELECT * FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE LIMIT 1`,
      [master_id]
    );
    if (!scheme.rows[0]) return res.status(400).json({ error: 'no active scheme for master' });
    const s = scheme.rows[0];

    // 2. посчитать услуги мастера за период (из online_bookings)
    const ob = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(s.price), 0)::numeric AS revenue
       FROM online_bookings ob
       LEFT JOIN services s ON s.id::text = ob.service_id
       WHERE ob.master_id=$1
         AND ob.date_from >= $2::date
         AND ob.date_from <  ($3::date + INTERVAL '1 day')
         AND ob.status IN ('confirmed','completed')`,
      [master_id, period_start, period_end]
    );
    const services_count = ob.rows[0]?.cnt || 0;
    const services_revenue = parseFloat(ob.rows[0]?.revenue || 0);

    // 3. рассчитать части
    let percent_part = 0, fixed_part = 0;
    if (s.scheme_type === 'percent' || s.scheme_type === 'hybrid') {
      percent_part = services_revenue * (parseFloat(s.percent || 0) / 100);
    }
    if (s.scheme_type === 'fixed' || s.scheme_type === 'hybrid') {
      if (s.fixed_per_month) fixed_part = parseFloat(s.fixed_per_month);
      else if (s.fixed_per_day) {
        const days = Math.ceil((new Date(period_end) - new Date(period_start)) / 86400000) + 1;
        fixed_part = parseFloat(s.fixed_per_day) * days;
      }
    }

    // 4. записать в payroll_records (draft)
    const rec = await pool.query(
      `INSERT INTO payroll_records (master_id, master_name, period_start, period_end,
                                    services_count, services_revenue, percent_part, fixed_part, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING id, total`,
      [master_id, s.master_name, period_start, period_end, services_count, services_revenue, percent_part, fixed_part]
    );
    res.json({ ok: true, record_id: rec.rows[0].id, total: rec.rows[0].total,
               breakdown: { services_count, services_revenue, percent_part, fixed_part } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/payroll/records — список начислений
router.get('/payroll/records', async (req, res) => {
  try {
    const { master_id, status, limit = 100 } = req.query;
    const where = [];
    const args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (status) { args.push(status); where.push(`status=$${args.length}`); }
    args.push(parseInt(limit));
    const sql = `SELECT * FROM payroll_records ${where.length ? 'WHERE '+where.join(' AND ') : ''}
                 ORDER BY period_start DESC LIMIT $${args.length}`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/payroll/records/:id — изменить статус (approve/paid)
router.patch('/payroll/records/:id', async (req, res) => {
  try {
    const { status, bonus, deduction, notes } = req.body || {};
    const sets = [];
    const args = [];
    if (status && ['draft', 'approved', 'paid'].includes(status)) { args.push(status); sets.push(`status=$${args.length}`); }
    if (typeof bonus === 'number') { args.push(bonus); sets.push(`bonus=$${args.length}`); }
    if (typeof deduction === 'number') { args.push(deduction); sets.push(`deduction=$${args.length}`); }
    if (notes !== undefined) { args.push(notes); sets.push(`notes=$${args.length}`); }
    if (!sets.length) return res.json({ ok: true, noop: true });
    args.push(req.params.id);
    await pool.query(`UPDATE payroll_records SET ${sets.join(', ')} WHERE id=$${args.length}`, args);

    // авто-расход в открытую кассовую смену при выплате ЗП
    if (status === 'paid') {
      try {
        const rec = await pool.query(`SELECT id, master_id, master_name, total FROM payroll_records WHERE id=$1`, [req.params.id]);
        const sh  = await pool.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
        if (rec.rows[0] && sh.rows[0] && +rec.rows[0].total > 0) {
          await pool.query(
            `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
             VALUES ($1,'out','salary',$2,'cash','payroll',$3,$4,$5)`,
            [sh.rows[0].id, rec.rows[0].total, rec.rows[0].id, rec.rows[0].master_id, `ЗП ${rec.rows[0].master_name||'#'+rec.rows[0].master_id}`]
          );
        }
      } catch (e) { console.warn('[payroll-cashbox]', e.message); }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ SUPPLIERS ═══════════════ */

router.post('/suppliers', async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await pool.query(
      `INSERT INTO suppliers (name, phone, email, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, phone || null, email || null, notes || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/suppliers', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM suppliers ORDER BY name`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ STOCK RECEIPTS (поставки) ═══════════════ */

router.post('/stock/receipts', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { supplier_id, invoice_no, items, notes } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'items array required' });
    }
    const total = items.reduce((s, it) => s + (parseFloat(it.qty) * parseFloat(it.unit_cost)), 0);
    const rcp = await client.query(
      `INSERT INTO stock_receipts (supplier_id, invoice_no, total_cost, notes)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [supplier_id || null, invoice_no || null, total, notes || null]
    );
    const receipt_id = rcp.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO stock_receipt_items (receipt_id, product_id, product_name, qty, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [receipt_id, it.product_id || null, it.product_name || null, it.qty, it.unit_cost]
      );
      // и обновляем stock в products если есть product_id
      if (it.product_id) {
        await client.query(
          `UPDATE products SET stock = COALESCE(stock,0) + $1 WHERE id=$2`,
          [it.qty, it.product_id]
        );
        await client.query(
          `INSERT INTO stock_movements (product_id, delta, reason, note)
           VALUES ($1,$2,'receipt',$3)`,
          [it.product_id, it.qty, `receipt #${receipt_id}`]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, receipt_id, total });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get('/stock/receipts', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, s.name AS supplier_name,
              (SELECT COUNT(*)::int FROM stock_receipt_items WHERE receipt_id=r.id) AS items_count
       FROM stock_receipts r LEFT JOIN suppliers s ON s.id=r.supplier_id
       ORDER BY r.received_at DESC LIMIT 200`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stock/receipts/:id', async (req, res) => {
  try {
    const head = await pool.query(
      `SELECT r.*, s.name AS supplier_name FROM stock_receipts r LEFT JOIN suppliers s ON s.id=r.supplier_id WHERE r.id=$1`,
      [req.params.id]
    );
    if (!head.rows[0]) return res.status(404).json({ error: 'not found' });
    const items = await pool.query(`SELECT * FROM stock_receipt_items WHERE receipt_id=$1 ORDER BY id`, [req.params.id]);
    res.json({ ...head.rows[0], items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ MATERIAL CONSUMPTION (списания мастером) ═══════════════ */

router.post('/stock/consumption', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { appointment_id, master_id, product_id, product_name, qty, unit_cost } = req.body || {};
    if (!qty || qty <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'qty > 0 required' });
    }
    const r = await client.query(
      `INSERT INTO material_consumption (appointment_id, master_id, product_id, product_name, qty, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, total_cost`,
      [appointment_id || null, master_id || null, product_id || null, product_name || null, qty, unit_cost || null]
    );
    if (product_id) {
      await client.query(`UPDATE products SET stock = GREATEST(COALESCE(stock,0) - $1, 0) WHERE id=$2`, [qty, product_id]);
      await client.query(
        `INSERT INTO stock_movements (product_id, delta, reason, note)
         VALUES ($1,$2,'consumption',$3)`,
        [product_id, -qty, `master ${master_id || 'unknown'} appointment ${appointment_id || '?'}`]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: r.rows[0].id, total_cost: r.rows[0].total_cost });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get('/stock/consumption', async (req, res) => {
  try {
    const { master_id, from, to, limit = 200 } = req.query;
    const where = [];
    const args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (from) { args.push(from); where.push(`consumed_at >= $${args.length}::date`); }
    if (to) { args.push(to); where.push(`consumed_at < ($${args.length}::date + INTERVAL '1 day')`); }
    args.push(parseInt(limit));
    const sql = `SELECT * FROM material_consumption ${where.length ? 'WHERE '+where.join(' AND ') : ''}
                 ORDER BY consumed_at DESC LIMIT $${args.length}`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
