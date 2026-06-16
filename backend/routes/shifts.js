/* routes/shifts.js — SAL-05 Зміни співробітників + табель + clock-in/out.
   Планові робочі зміни майстрів, фактичні відмітки приходу/виходу,
   агрегат відпрацьованих годин (табель). Не плутати з cash_shifts (каса).
   Доступ: GET = schedule.read, мутації = schedule.write (як журнал). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'schedule.read' : 'schedule.write';
  return requirePerm(perm)(req, res, next);
});

// Київська дата "сьогодні"
function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ── GET /api/shifts?from=&to=&master_id= — зміни за період ──
router.get('/', async (req, res) => {
  try {
    const from = req.query.from || kyivToday();
    const to = req.query.to || from;
    const params = [from, to];
    let where = 's.shift_date BETWEEN $1 AND $2';
    if (req.query.master_id) { params.push(+req.query.master_id); where += ` AND s.master_id = $${params.length}`; }
    const r = await pool.query(
      `SELECT s.*, m.name AS master_name, m.avatar AS master_avatar,
              EXTRACT(EPOCH FROM (s.clock_out - s.clock_in))/3600 AS hours_worked
         FROM staff_shifts s JOIN masters m ON m.id = s.master_id
        WHERE ${where}
        ORDER BY s.shift_date, m.name`, params);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/shifts/timesheet?from=&to= — табель: години по майстрах ──
router.get('/timesheet', async (req, res) => {
  try {
    const from = req.query.from || kyivToday();
    const to = req.query.to || from;
    const r = await pool.query(
      `SELECT m.id AS master_id, m.name AS master_name,
              COUNT(s.id)::int AS shifts_total,
              COUNT(s.id) FILTER (WHERE s.status='done')::int AS shifts_done,
              COUNT(s.id) FILTER (WHERE s.status='missed')::int AS shifts_missed,
              COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (s.clock_out - s.clock_in))/3600)::numeric, 1), 0) AS hours_worked,
              COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (
                (s.shift_date + s.planned_end) - (s.shift_date + s.planned_start)))/3600)::numeric, 1), 0) AS hours_planned
         FROM masters m
         LEFT JOIN staff_shifts s ON s.master_id = m.id AND s.shift_date BETWEEN $1 AND $2
        WHERE m.active = true
        GROUP BY m.id, m.name
        ORDER BY hours_worked DESC, m.name`, [from, to]);
    res.json({ from, to, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts — створити/запланувати зміну ──
router.post('/', async (req, res) => {
  try {
    const { master_id, shift_date, planned_start, planned_end, branch_id, notes } = req.body || {};
    if (!master_id || !shift_date) return res.status(400).json({ error: 'master_id and shift_date required' });
    const r = await pool.query(
      `INSERT INTO staff_shifts (master_id, shift_date, planned_start, planned_end, branch_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (master_id, shift_date) DO UPDATE
         SET planned_start=EXCLUDED.planned_start, planned_end=EXCLUDED.planned_end,
             branch_id=EXCLUDED.branch_id, notes=EXCLUDED.notes, updated_at=NOW()
       RETURNING *`,
      [master_id, shift_date, planned_start || null, planned_end || null, branch_id || null, notes || null, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'shift.create', entity: 'staff_shift', entity_id: r.rows[0].id, ip: req.ip, meta: { master_id, shift_date } }).catch(()=>{});
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/shifts/:id — редагувати зміну ──
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['shift_date', 'planned_start', 'planned_end', 'branch_id', 'notes', 'status', 'clock_in', 'clock_out'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(+req.params.id);
    const r = await pool.query(
      `UPDATE staff_shifts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/:id/clock-in — відмітка приходу ──
router.post('/:id/clock-in', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE staff_shifts SET clock_in=NOW(), status='working', updated_at=NOW()
       WHERE id=$1 RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'shift.clock_in', entity: 'staff_shift', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/:id/clock-out — відмітка виходу ──
router.post('/:id/clock-out', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE staff_shifts SET clock_out=NOW(), status='done', updated_at=NOW()
       WHERE id=$1 RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'shift.clock_out', entity: 'staff_shift', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/shifts/:id ──
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM staff_shifts WHERE id=$1 RETURNING id`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'shift.delete', entity: 'staff_shift', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
