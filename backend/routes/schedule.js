/* Schedule: расписание мастеров — CRUD + синк с BeautyPro
   Подключается как /api/schedule */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const router = express.Router();

// GET = schedule.read, мутации = schedule.write
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'schedule.read' : 'schedule.write';
  return requirePerm(perm)(req, res, next);
});

// ── GET /api/schedule/masters — все активные мастера с расписанием ──
router.get('/masters', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, name, specialty, avatar, schedule_json, active, beautypro_id
         FROM masters WHERE active = true ORDER BY name`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/schedule/masters/:id — один мастер с расписанием ──
router.get('/masters/:id', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query('SELECT * FROM masters WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/schedule/masters/:id/schedule — обновить расписание мастера ──
// Body: { schedule: { mon: { start: "09:00", end: "18:00" }, tue: {...}, ... } }
// Выходной = null или отсутствует. Пример: { mon: { start: "09:00", end: "18:00" }, tue: null, wed: {...} }
router.put('/masters/:id/schedule', async (req, res) => {
  try {
    const pool = getPool();
    const { schedule } = req.body || {};
    if (!schedule || typeof schedule !== 'object') {
      return res.status(400).json({ error: 'schedule object required' });
    }
    // Валидация дней
    const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const clean = {};
    for (const [day, val] of Object.entries(schedule)) {
      if (!validDays.includes(day)) continue;
      if (val === null || val === false) { clean[day] = null; continue; }
      if (!val.start || !val.end) continue;
      // Проверка формата HH:MM
      if (!/^\d{2}:\d{2}$/.test(val.start) || !/^\d{2}:\d{2}$/.test(val.end)) continue;
      clean[day] = { start: val.start, end: val.end, break_start: val.break_start || null, break_end: val.break_end || null };
    }
    const r = await pool.query(
      'UPDATE masters SET schedule_json = $1 WHERE id = $2 RETURNING id, name, schedule_json',
      [JSON.stringify(clean), req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json({ ok: true, master: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/schedule/masters/:id/dayoff — добавить разовый выходной ──
// Body: { date: "2026-06-10", reason: "больничный" }
router.post('/masters/:id/dayoff', async (req, res) => {
  try {
    const pool = getPool();
    const { date, reason } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    // Храним в отдельной таблице или в schedule_json.exceptions
    const master = await pool.query('SELECT schedule_json FROM masters WHERE id = $1', [req.params.id]);
    if (!master.rows[0]) return res.status(404).json({ error: 'master not found' });
    const sched = master.rows[0].schedule_json || {};
    if (!sched.exceptions) sched.exceptions = {};
    sched.exceptions[date] = { off: true, reason: reason || null };
    await pool.query('UPDATE masters SET schedule_json = $1 WHERE id = $2', [JSON.stringify(sched), req.params.id]);
    res.json({ ok: true, date, off: true, reason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/schedule/masters/:id/dayoff/:date — убрать разовый выходной ──
router.delete('/masters/:id/dayoff/:date', async (req, res) => {
  try {
    const pool = getPool();
    const master = await pool.query('SELECT schedule_json FROM masters WHERE id = $1', [req.params.id]);
    if (!master.rows[0]) return res.status(404).json({ error: 'master not found' });
    const sched = master.rows[0].schedule_json || {};
    if (sched.exceptions) delete sched.exceptions[req.params.date];
    await pool.query('UPDATE masters SET schedule_json = $1 WHERE id = $2', [JSON.stringify(sched), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/schedule/availability?date=2026-06-10 — кто работает в конкретный день ──
router.get('/availability', async (req, res) => {
  try {
    const pool = getPool();
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date).getDay()];

    const masters = await pool.query(
      'SELECT id, name, specialty, avatar, schedule_json FROM masters WHERE active = true'
    );

    const available = [];
    for (const m of masters.rows) {
      const sched = m.schedule_json || {};
      // Проверяем исключения (разовые выходные)
      if (sched.exceptions && sched.exceptions[date] && sched.exceptions[date].off) continue;
      // Проверяем обычное расписание
      const daySchedule = sched[dayOfWeek];
      if (!daySchedule) continue; // выходной
      available.push({
        id: m.id,
        name: m.name,
        specialty: m.specialty,
        avatar: m.avatar,
        start: daySchedule.start,
        end: daySchedule.end,
        break_start: daySchedule.break_start,
        break_end: daySchedule.break_end,
      });
    }

    res.json({ date, day: dayOfWeek, available, count: available.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/schedule/sync-beautypro — подтянуть мастеров из BeautyPro ──
router.post('/sync-beautypro', async (req, res) => {
  try {
    const pool = getPool();
    const bp = require('../beautyproClient');
    const employees = await bp.listEmployees();

    let synced = 0;
    const errors = [];
    for (const emp of employees) {
      const bpId = String(emp.id || '').trim();
      if (!bpId || !emp.name) continue;
      // Upsert: проверяем есть ли уже мастер с таким beautypro_id
      const existing = await pool.query(
        'SELECT id FROM masters WHERE beautypro_id = $1', [bpId]
      );
      try {
        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE masters SET name = $1, active = true WHERE beautypro_id = $2',
            [emp.name, bpId]
          );
        } else {
          await pool.query(
            'INSERT INTO masters (name, beautypro_id, active) VALUES ($1, $2, true)',
            [emp.name, bpId]
          );
        }
        synced++;
      } catch (insertErr) {
        errors.push({ name: emp.name, bpId, error: insertErr.message });
      }
    }

    res.json({ ok: true, synced, errors: errors.length ? errors : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/schedule/journal?date=YYYY-MM-DD ──────────────
// Журнал записів на день у стилі DIKIDI: майстри-колонки + записи з усіма деталями.
router.get('/journal', async (req, res) => {
  try {
    const pool = getPool();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad-date (YYYY-MM-DD)' });
    const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date + 'T00:00:00').getDay()];

    // майстри + їх робочий час на цей день тижня
    const mRes = await pool.query(
      `SELECT id, name, specialty, avatar, schedule_json FROM masters WHERE active = true ORDER BY name`
    );
    const masters = mRes.rows.map(m => {
      const s = m.schedule_json || {};
      const off = !!(s.exceptions && s.exceptions[date] && s.exceptions[date].off);
      const wd = (!off && s[dayKey]) ? s[dayKey] : null;
      return {
        id: m.id, name: m.name, specialty: m.specialty, avatar: m.avatar,
        working: !!wd,
        start: wd ? wd.start : null, end: wd ? wd.end : null,
        break_start: wd ? (wd.break_start || null) : null,
        break_end: wd ? (wd.break_end || null) : null,
        day_off_reason: off ? (s.exceptions[date].reason || 'Вихідний') : null,
      };
    });

    // записи на день: appointment + майстер + послуга + клієнт
    const aRes = await pool.query(
      `SELECT a.id, a.master_id, a.service_id, a.client_id,
              a.starts_at, a.ends_at, a.status, a.notes,
              COALESCE(a.price, s.price) AS price,
              s.name AS service_name,
              COALESCE(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at))/60, s.duration_min) AS duration_min,
              m.name AS master_name,
              COALESCE(
                NULLIF(c.name,''),
                CASE WHEN a.bp_client ~* '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN NULL ELSE a.bp_client END,
                'Клієнт'
              ) AS client_name,
              c.phone AS client_phone
         FROM appointments a
         LEFT JOIN masters  m ON m.id = a.master_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN clients  c ON c.id = a.client_id
        WHERE a.starts_at >= $1::date
          AND a.starts_at <  ($1::date + INTERVAL '1 day')
          AND COALESCE(a.status,'') NOT IN ('cancelled')
        ORDER BY a.starts_at`,
      [date]
    );

    res.json({ date, day: dayKey, masters, appointments: aRes.rows, count: aRes.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/schedule/appointments/:id — заметка / статус ──
router.patch('/appointments/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { notes, status } = req.body || {};
    if (notes === undefined && status === undefined) {
      return res.status(400).json({ error: 'nothing-to-update' });
    }
    const allowed = ['booked', 'confirmed', 'done', 'cancelled', 'noshow'];
    if (status !== undefined && !allowed.includes(status)) {
      return res.status(400).json({ error: 'bad-status' });
    }
    const r = await pool.query(
      `UPDATE appointments
          SET notes = COALESCE($2, notes),
              status = COALESCE($3, status),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, notes, status`,
      [req.params.id, notes ?? null, status ?? null]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    res.json({ ok: true, appointment: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
