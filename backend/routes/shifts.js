/* routes/shifts.js — SAL-05 Зміни співробітників + табель + clock-in/out.
   Планові робочі зміни майстрів, фактичні відмітки приходу/виходу,
   агрегат відпрацьованих годин (табель). Не плутати з cash_shifts (каса).
   Доступ: GET = schedule.read, мутації = schedule.write (як журнал). */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
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
                (s.shift_date + s.planned_end) - (s.shift_date + s.planned_start)))/3600)::numeric, 1), 0) AS hours_planned,
              COALESCE(ROUND(SUM(s.overtime_hours)::numeric, 1), 0) AS overtime_hours,
              COALESCE(SUM(s.late_minutes), 0)::int AS late_minutes_total,
              COUNT(s.id) FILTER (WHERE s.late_minutes > 0)::int AS late_count
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

// ── POST /api/shifts/:id/clock-in — відмітка приходу (рахує опізнення) ──
router.post('/:id/clock-in', async (req, res) => {
  try {
    // late_minutes: різниця між фактичним приходом (Київ) і planned_start, але не менше 0
    const r = await pool.query(
      `UPDATE staff_shifts SET clock_in=NOW(), status='working', updated_at=NOW(),
              late_minutes = GREATEST(0, COALESCE(
                EXTRACT(EPOCH FROM (
                  (NOW() AT TIME ZONE 'Europe/Kiev')::time - planned_start
                ))/60, 0))::int
       WHERE id=$1 RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'shift.clock_in', entity: 'staff_shift', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/:id/clock-out — відмітка виходу (рахує переробку) ──
router.post('/:id/clock-out', async (req, res) => {
  try {
    // overtime_hours: фактично відпрацьовано понад planned_hours (або planned_start..planned_end)
    const r = await pool.query(
      `UPDATE staff_shifts SET clock_out=NOW(), status='done', updated_at=NOW(),
              overtime_hours = GREATEST(0, ROUND((
                EXTRACT(EPOCH FROM (NOW() - clock_in))/3600
                - COALESCE(planned_hours,
                    EXTRACT(EPOCH FROM (planned_end - planned_start))/3600, 0)
              )::numeric, 1))
       WHERE id=$1 AND clock_in IS NOT NULL RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found or no clock_in' });
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

// ═══════════════════════════════════════════════════════════════════
// SAL-05: шаблони змін, генерація/публікація графіка, обмін, переробки
// ═══════════════════════════════════════════════════════════════════

const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':'); return (+h) * 60 + (+m || 0); };
// JS getDay 0=Нд..6=Сб → наш dow 0=Пн..6=Нд
const jsDowToOurs = (d) => (d + 6) % 7;
function plannedHours(start, end) {
  const a = toMin(start), b = toMin(end);
  if (a == null || b == null) return null;
  let diff = b - a; if (diff < 0) diff += 24 * 60;  // нічна зміна
  return Math.round((diff / 60) * 10) / 10;
}

// ── GET /api/shifts/templates — список шаблонів ──
router.get('/templates', async (req, res) => {
  try {
    const status = req.query.status || 'active';
    const rows = await q(`SELECT * FROM shift_templates WHERE status=$1 ORDER BY name`, [status]);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/templates — створити шаблон ──
router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const ph = b.planned_hours != null ? b.planned_hours : plannedHours(b.start_time || '09:00', b.end_time || '21:00');
    const r = await q(
      `INSERT INTO shift_templates (name, shift_type, start_time, end_time, planned_hours, weekdays, rotation_pattern, position, min_staff, branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.shift_type || 'full', b.start_time || '09:00', b.end_time || '21:00', ph,
       b.weekdays || [], b.rotation_pattern || 'weekly', b.position || null, b.min_staff || 1,
       b.branch_id || null, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'shift_template.create', entity: 'shift_template', entity_id: r[0].id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, template: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/shifts/templates/:id ──
router.patch('/templates/:id', async (req, res) => {
  try {
    const allowed = ['name', 'shift_type', 'start_time', 'end_time', 'planned_hours', 'weekdays', 'rotation_pattern', 'position', 'min_staff', 'branch_id', 'status'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(+req.params.id);
    const r = await q(`UPDATE shift_templates SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, template: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/shifts/templates/:id (архівувати) ──
router.delete('/templates/:id', async (req, res) => {
  try {
    const r = await q(`UPDATE shift_templates SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id`, [+req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/generate — згенерувати графік з шаблону на період ──
// body: { template_id, from, to, master_ids:[...], publish:false }
router.post('/generate', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.template_id || !b.from || !b.to || !Array.isArray(b.master_ids) || !b.master_ids.length)
      return res.status(400).json({ error: 'template_id, from, to, master_ids[] required' });
    const tpl = (await q(`SELECT * FROM shift_templates WHERE id=$1`, [+b.template_id]))[0];
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const from = new Date(b.from + 'T00:00:00Z'), to = new Date(b.to + 'T00:00:00Z');
    if (isNaN(from) || isNaN(to) || to < from) return res.status(400).json({ error: 'bad date range' });
    if ((to - from) / 86400000 > 92) return res.status(400).json({ error: 'range too long (max 92 days)' });

    const weekdays = (tpl.weekdays || []).map(Number);
    const rot = tpl.rotation_pattern || 'weekly';
    // ротація N/M: N днів робота, M вихідні, циклічно від from
    const rotParse = /^(\d+)\/(\d+)$/.exec(rot);
    const ph = tpl.planned_hours != null ? tpl.planned_hours : plannedHours(tpl.start_time, tpl.end_time);
    const status = b.publish ? 'published' : 'planned';
    const pubAt = b.publish ? 'NOW()' : 'NULL';

    let created = 0, skipped = 0;
    const masterIds = b.master_ids.map(Number);
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      let work = false;
      if (rotParse) {
        const on = +rotParse[1], off = +rotParse[2], cyc = on + off;
        const dayIdx = Math.floor((d - from) / 86400000);
        work = (dayIdx % cyc) < on;
      } else {
        // weekly: за weekdays
        work = weekdays.length === 0 ? false : weekdays.includes(jsDowToOurs(d.getUTCDay()));
      }
      if (!work) continue;
      for (const mid of masterIds) {
        const r = await q(
          `INSERT INTO staff_shifts (master_id, shift_date, planned_start, planned_end, planned_hours, shift_type, template_id, branch_id, status, published_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${pubAt},$10)
           ON CONFLICT (master_id, shift_date) DO NOTHING RETURNING id`,
          [mid, ds, tpl.start_time, tpl.end_time, ph, tpl.shift_type, tpl.id, tpl.branch_id, status, req.user?.display_name || null]);
        if (r[0]) created++; else skipped++;
      }
    }
    logAction({ user: req.user, action: 'shift.generate', entity: 'shift_template', entity_id: tpl.id, ip: req.ip, meta: { from: b.from, to: b.to, created } }).catch(()=>{});
    res.json({ ok: true, created, skipped, published: !!b.publish });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/publish — опублікувати графік за період ──
// body: { from, to, master_id? }
router.post('/publish', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.from || !b.to) return res.status(400).json({ error: 'from, to required' });
    const params = [b.from, b.to];
    let where = `shift_date BETWEEN $1 AND $2 AND status='planned'`;
    if (b.master_id) { params.push(+b.master_id); where += ` AND master_id=$${params.length}`; }
    const r = await q(`UPDATE staff_shifts SET status='published', published_at=NOW(), updated_at=NOW() WHERE ${where} RETURNING id`, params);
    logAction({ user: req.user, action: 'shift.publish', entity: 'staff_shift', ip: req.ip, meta: { from: b.from, to: b.to, count: r.length } }).catch(()=>{});
    res.json({ ok: true, published: r.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/shifts/:id/confirm — майстер підтверджує свою зміну ──
router.post('/:id(\\d+)/confirm', async (req, res) => {
  try {
    const r = await q(`UPDATE staff_shifts SET status='confirmed', confirmed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status IN ('published','planned') RETURNING *`, [+req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found or not publishable' });
    res.json({ ok: true, shift: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── SWAP: обмін змінами ─────────────────────────────────────────────
// GET /api/shifts/swaps?status=
router.get('/swaps', async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.status) { params.push(req.query.status); wh.push(`sw.status=$${params.length}`); }
    if (req.query.master_id) { params.push(+req.query.master_id); wh.push(`(sw.requester_id=$${params.length} OR sw.acceptor_id=$${params.length})`); }
    const rows = await q(
      `SELECT sw.*, rm.name AS requester_name, am.name AS acceptor_name,
              s1.shift_date AS shift_date, s2.shift_date AS target_shift_date
         FROM shift_swaps sw
         JOIN masters rm ON rm.id = sw.requester_id
         LEFT JOIN masters am ON am.id = sw.acceptor_id
         JOIN staff_shifts s1 ON s1.id = sw.shift_id
         LEFT JOIN staff_shifts s2 ON s2.id = sw.target_shift_id
        ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
        ORDER BY sw.created_at DESC`, params);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/shifts/swaps — запросити обмін
router.post('/swaps', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.shift_id || !b.requester_id) return res.status(400).json({ error: 'shift_id, requester_id required' });
    const sh = (await q(`SELECT id, master_id FROM staff_shifts WHERE id=$1`, [+b.shift_id]))[0];
    if (!sh) return res.status(404).json({ error: 'shift not found' });
    if (sh.master_id !== +b.requester_id) return res.status(403).json({ error: 'not your shift' });
    const r = await q(
      `INSERT INTO shift_swaps (shift_id, target_shift_id, requester_id, acceptor_id, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [+b.shift_id, b.target_shift_id || null, +b.requester_id, b.acceptor_id || null, b.reason || null]);
    logAction({ user: req.user, action: 'shift_swap.request', entity: 'shift_swap', entity_id: r[0].id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, swap: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/shifts/swaps/:id/accept — інший майстер погоджується прийняти
router.post('/swaps/:id/accept', async (req, res) => {
  try {
    const acceptor_id = req.body?.acceptor_id;
    if (!acceptor_id) return res.status(400).json({ error: 'acceptor_id required' });
    const r = await q(`UPDATE shift_swaps SET status='accepted', acceptor_id=$2, accepted_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`, [+req.params.id, +acceptor_id]);
    if (!r[0]) return res.status(404).json({ error: 'not found or not pending' });
    res.json({ ok: true, swap: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/shifts/swaps/:id/approve — адмін затверджує → реально міняє master_id у змінах
router.post('/swaps/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client); // RLS-ізоляція (аудит 06.07)
    const swr = await client.query(`SELECT * FROM shift_swaps WHERE id=$1 FOR UPDATE`, [+req.params.id]);
    const sw = swr.rows[0];
    if (!sw) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (sw.status !== 'accepted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'swap must be accepted first' }); }
    // переписуємо master_id: shift → acceptor, target_shift → requester
    await client.query(`UPDATE staff_shifts SET master_id=$1, updated_at=NOW() WHERE id=$2`, [sw.acceptor_id, sw.shift_id]);
    if (sw.target_shift_id) {
      await client.query(`UPDATE staff_shifts SET master_id=$1, updated_at=NOW() WHERE id=$2`, [sw.requester_id, sw.target_shift_id]);
    }
    const upd = await client.query(`UPDATE shift_swaps SET status='completed', approved_at=NOW(), approved_by=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [+req.params.id, req.user?.display_name || null]);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'shift_swap.approve', entity: 'shift_swap', entity_id: sw.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, swap: upd.rows[0] });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  finally { client.release(); }
});

// POST /api/shifts/swaps/:id/reject
router.post('/swaps/:id/reject', async (req, res) => {
  try {
    const r = await q(`UPDATE shift_swaps SET status='rejected', reject_reason=$2, updated_at=NOW()
       WHERE id=$1 AND status IN ('pending','accepted') RETURNING *`, [+req.params.id, req.body?.reason || null]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, swap: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/shifts/swaps/:id/cancel — заявник скасовує
router.post('/swaps/:id/cancel', async (req, res) => {
  try {
    const r = await q(`UPDATE shift_swaps SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND status IN ('pending','accepted') RETURNING *`, [+req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, swap: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
