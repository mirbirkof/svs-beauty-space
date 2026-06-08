/* Schedule: расписание мастеров — CRUD + синк с BeautyPro
   Подключается как /api/schedule */
const express = require('express');
const { getPool } = require('../db-pg');
const router = express.Router();

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
      const bpId = parseInt(emp.id, 10);
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

    // Debug: count in DB after sync
    const countR = await pool.query('SELECT count(*) FROM masters');
    res.json({ ok: true, synced, dbCount: parseInt(countR.rows[0].count), errors: errors.length ? errors : undefined, employeesFromBP: employees.length, sample: employees.slice(0, 3).map(e => ({id: e.id, name: e.name})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
