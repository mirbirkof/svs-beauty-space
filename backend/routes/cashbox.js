/* Cashbox: смены, операции, Z-отчёт.
   Финансовый учёт салона — приход/расход кассы по сменам.
   Подключается как /api/cashbox в shop-api.js */
const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── helpers ────────────────────────────────────────────
async function getOpenShift(branchId) {
  const r = await pool.query(
    `SELECT * FROM cash_shifts WHERE status='open' AND (branch_id=$1 OR $1 IS NULL) ORDER BY opened_at DESC LIMIT 1`,
    [branchId || null]
  );
  return r.rows[0] || null;
}

async function recalcShiftTotals(shiftId) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE 0 END),0) AS total_in,
       COALESCE(SUM(CASE WHEN type='out' THEN amount ELSE 0 END),0) AS total_out,
       COALESCE(SUM(CASE WHEN type='in' AND method='cash' THEN amount ELSE 0 END),0) AS cash_in,
       COALESCE(SUM(CASE WHEN type='out' AND method='cash' THEN amount ELSE 0 END),0) AS cash_out
     FROM cash_operations WHERE shift_id=$1`,
    [shiftId]
  );
  return r.rows[0];
}

// ── SHIFTS ─────────────────────────────────────────────

// POST /api/cashbox/shifts/open — открыть смену
router.post('/shifts/open', async (req, res) => {
  try {
    const { branch_id, opened_by, opening_cash, notes } = req.body || {};
    const existing = await getOpenShift(branch_id);
    if (existing) return res.status(409).json({ error: 'shift-already-open', shift: existing });
    const r = await pool.query(
      `INSERT INTO cash_shifts (branch_id, opened_by, opening_cash, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [branch_id || null, opened_by || null, opening_cash || 0, notes || null]
    );
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cashbox/shifts/current — текущая открытая
router.get('/shifts/current', async (req, res) => {
  try {
    const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
    const shift = await getOpenShift(branchId);
    if (!shift) return res.json({ shift: null });
    const totals = await recalcShiftTotals(shift.id);
    const expected = Number(shift.opening_cash) + Number(totals.cash_in) - Number(totals.cash_out);
    res.json({ shift, totals, expected_cash: expected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cashbox/shifts — история смен
router.get('/shifts', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT id, branch_id, opened_by, opened_at, closed_at, opening_cash, closing_cash,
              expected_cash, difference, status
       FROM cash_shifts ORDER BY opened_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cashbox/shifts/:id — детали смены
router.get('/shifts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = await pool.query(`SELECT * FROM cash_shifts WHERE id=$1`, [id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'not-found' });
    const ops = await pool.query(
      `SELECT * FROM cash_operations WHERE shift_id=$1 ORDER BY created_at`,
      [id]
    );
    const totals = await recalcShiftTotals(id);
    res.json({ shift: s.rows[0], operations: ops.rows, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cashbox/shifts/:id/close — закрыть смену + Z-отчёт
router.post('/shifts/:id/close', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { closing_cash, closed_by, notes } = req.body || {};

    await client.query('BEGIN');
    const s = await client.query(`SELECT * FROM cash_shifts WHERE id=$1 FOR UPDATE`, [id]);
    if (!s.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (s.rows[0].status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not-open' }); }

    const totals = await recalcShiftTotals(id);
    const opening = Number(s.rows[0].opening_cash);
    const expected = opening + Number(totals.cash_in) - Number(totals.cash_out);
    const closing = closing_cash != null ? Number(closing_cash) : expected;
    const diff = closing - expected;

    await client.query(
      `UPDATE cash_shifts SET status='closed', closed_at=NOW(), closing_cash=$1,
       expected_cash=$2, difference=$3, notes=COALESCE($4,notes) WHERE id=$5`,
      [closing, expected, diff, notes || null, id]
    );

    // Z-отчёт: подробная сводка по категориям
    const breakdown = await client.query(
      `SELECT type, category, method, COUNT(*) AS cnt, SUM(amount) AS total
       FROM cash_operations WHERE shift_id=$1 GROUP BY type, category, method`,
      [id]
    );
    const byCategory = {};
    let servicesTotal = 0, productsTotal = 0, salaryTotal = 0, supplierTotal = 0;
    let cardIn = 0, transferIn = 0;
    for (const row of breakdown.rows) {
      const key = `${row.type}_${row.category}`;
      byCategory[key] = (byCategory[key] || 0) + Number(row.total);
      if (row.type === 'in' && row.category === 'sale_service') servicesTotal += Number(row.total);
      if (row.type === 'in' && row.category === 'sale_product') productsTotal += Number(row.total);
      if (row.type === 'out' && row.category === 'salary') salaryTotal += Number(row.total);
      if (row.type === 'out' && row.category === 'supplier') supplierTotal += Number(row.total);
      if (row.type === 'in' && row.method === 'card') cardIn += Number(row.total);
      if (row.type === 'in' && row.method === 'transfer') transferIn += Number(row.total);
    }
    const opsCnt = await client.query(`SELECT COUNT(*)::int AS n FROM cash_operations WHERE shift_id=$1`, [id]);

    const z = await client.query(
      `INSERT INTO z_reports (shift_id, branch_id, period_start, period_end,
         total_in, total_out, cash_in, cash_out, card_in, transfer_in,
         services_total, products_total, salary_total, supplier_total,
         operations_cnt, opening_cash, closing_cash, expected_cash, difference,
         raw_breakdown, closed_by)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [id, s.rows[0].branch_id, s.rows[0].opened_at,
       totals.total_in, totals.total_out, totals.cash_in, totals.cash_out, cardIn, transferIn,
       servicesTotal, productsTotal, salaryTotal, supplierTotal,
       opsCnt.rows[0].n, opening, closing, expected, diff,
       JSON.stringify(byCategory), closed_by || null]
    );

    await client.query('COMMIT');
    res.json({ ok: true, shift_id: id, z_report: z.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── OPERATIONS ─────────────────────────────────────────

// POST /api/cashbox/operations — добавить операцию (приход/расход)
router.post('/operations', async (req, res) => {
  try {
    const { shift_id, type, category, amount, method, ref_type, ref_id, master_id, description } = req.body || {};
    if (!type || !category || !amount) return res.status(400).json({ error: 'type, category, amount required' });
    if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'bad type' });
    if (Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    let sid = shift_id;
    if (!sid) {
      const open = await getOpenShift(null);
      if (!open) return res.status(400).json({ error: 'no-open-shift' });
      sid = open.id;
    } else {
      const chk = await pool.query(`SELECT status FROM cash_shifts WHERE id=$1`, [sid]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'shift-not-found' });
      if (chk.rows[0].status !== 'open') return res.status(400).json({ error: 'shift-closed' });
    }

    const r = await pool.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [sid, type, category, amount, method || 'cash', ref_type || null, ref_id || null, master_id || null, description || null]
    );
    res.json({ ok: true, operation: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cashbox/operations?shift_id=N — операции по смене
router.get('/operations', async (req, res) => {
  try {
    const shiftId = Number(req.query.shift_id);
    if (!shiftId) return res.status(400).json({ error: 'shift_id required' });
    const r = await pool.query(
      `SELECT * FROM cash_operations WHERE shift_id=$1 ORDER BY created_at`,
      [shiftId]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/cashbox/operations/:id — удалить (только в открытой смене)
router.delete('/operations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const op = await pool.query(
      `SELECT o.*, s.status AS shift_status FROM cash_operations o
       JOIN cash_shifts s ON s.id=o.shift_id WHERE o.id=$1`, [id]
    );
    if (!op.rows[0]) return res.status(404).json({ error: 'not-found' });
    if (op.rows[0].shift_status !== 'open') return res.status(400).json({ error: 'shift-closed' });
    await pool.query(`DELETE FROM cash_operations WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Z-REPORTS ──────────────────────────────────────────

// GET /api/cashbox/z-reports — список
router.get('/z-reports', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const r = await pool.query(
      `SELECT * FROM z_reports ORDER BY period_end DESC LIMIT $1`, [limit]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cashbox/z-reports/:id
router.get('/z-reports/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM z_reports WHERE id=$1`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ report: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TAXES ──────────────────────────────────────────────

router.get('/taxes', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM tax_records ORDER BY period_start DESC`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/taxes', async (req, res) => {
  try {
    const { period_start, period_end, type, base_amount, tax_amount, notes } = req.body || {};
    if (!period_start || !period_end || !type) return res.status(400).json({ error: 'period_start, period_end, type required' });
    const r = await pool.query(
      `INSERT INTO tax_records (period_start, period_end, type, base_amount, tax_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [period_start, period_end, type, base_amount || 0, tax_amount || 0, notes || null]
    );
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/taxes/:id/pay', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { paid_amount } = req.body || {};
    const r = await pool.query(
      `UPDATE tax_records SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE id=$2 RETURNING *`,
      [paid_amount || null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
