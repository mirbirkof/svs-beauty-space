/* routes/rooms.js — SAL-03 Rooms & Cabinets (кабинеты/залы салона).
   Реестр помещений, оборудование, расписание доступности, блокировки (ремонт/санобработка),
   проверка доступности по записям (appointments), подбор свободного кабинета, аналитика загрузки.
   rooms — single-salon таблица (027), integer id, без RLS — дочерние таблицы той же модели.
   Доступ: GET — открыты (нужны booking/calendar); мутации — settings.write (как было). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const W = requirePerm('settings.write');

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Строит слоты дня кабинета: рабочие часы − записи − блоки. slotMin — шаг сетки.
function buildSlots(sched, appts, blocks, slotMin = 30) {
  if (!sched || sched.is_day_off) return { slots: [], occupancy_percent: 0 };
  const open = toMin(sched.open_time), close = toMin(sched.close_time);
  const brkS = sched.break_start ? toMin(sched.break_start) : null;
  const brkE = sched.break_end ? toMin(sched.break_end) : null;
  const slots = [];
  let busyMin = 0;
  for (let t = open; t + slotMin <= close; t += slotMin) {
    const from = t, to = t + slotMin;
    let status = 'free', appointment_id = null;
    if (brkS != null && from < brkE && to > brkS) status = 'break';
    const ap = appts.find(a => {
      const s = a._s, e = a._e; return s < to && e > from;
    });
    if (ap) { status = 'booked'; appointment_id = ap.id; busyMin += slotMin; }
    const bl = blocks.find(b => b._s < to && b._e > from);
    if (bl && status !== 'booked') status = 'blocked';
    slots.push({ from: toHHMM(from), to: toHHMM(to), status, appointment_id });
  }
  const work = Math.max(close - open - (brkS != null ? (brkE - brkS) : 0), 1);
  return { slots, occupancy_percent: +(busyMin / work * 100).toFixed(1) };
}

// Грузит записи кабинета на дату как массив {id,_s,_e} в минутах от полуночи.
async function apptsForRoom(roomId, date) {
  const rows = await q(
    `SELECT id, starts_at, ends_at FROM appointments
      WHERE room_id=$1 AND status NOT IN ('cancelled','noshow')
        AND starts_at::date = $2::date`,
    [roomId, date]
  );
  return rows.map(r => ({
    id: r.id,
    _s: new Date(r.starts_at).getHours() * 60 + new Date(r.starts_at).getMinutes(),
    _e: new Date(r.ends_at).getHours() * 60 + new Date(r.ends_at).getMinutes(),
  }));
}
async function blocksForRoom(roomId, date) {
  const rows = await q(
    `SELECT id, blocked_from, blocked_until FROM room_blocks
      WHERE room_id=$1 AND status='active'
        AND blocked_from::date <= $2::date AND blocked_until::date >= $2::date`,
    [roomId, date]
  );
  return rows.map(r => ({
    id: r.id,
    _s: new Date(r.blocked_from).getHours() * 60 + new Date(r.blocked_from).getMinutes(),
    _e: new Date(r.blocked_until).getHours() * 60 + new Date(r.blocked_until).getMinutes() || 1440,
  }));
}
async function scheduleForRoom(roomId, date, season = 'default') {
  // day_of_week: 0=пн … 6=вс (в JS getDay: 0=вс)
  const jsDay = new Date(date).getDay();
  const dow = jsDay === 0 ? 6 : jsDay - 1;
  let s = await q(
    `SELECT * FROM room_schedules WHERE room_id=$1 AND day_of_week=$2 AND season=$3
        AND valid_from <= $4::date AND (valid_until IS NULL OR valid_until >= $4::date)
      ORDER BY valid_from DESC LIMIT 1`,
    [roomId, dow, season, date]
  );
  if (!s.length && season !== 'default') {
    s = await q(`SELECT * FROM room_schedules WHERE room_id=$1 AND day_of_week=$2 AND season='default' LIMIT 1`, [roomId, dow]);
  }
  // дефолт если расписание не задано — 09:00-21:00
  return s[0] || { is_day_off: false, open_time: '09:00', close_time: '21:00', break_start: null, break_end: null };
}

// ═══ СПЕЦ-МАРШРУТЫ (до /:id) ═════════════════════════════════════════════════

// GET /availability?branch_id=&date=&room_type= — матрица занятости всех кабинетов
router.get('/availability', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const where = ['deleted_at IS NULL', "status='active'"]; const vals = [];
    if (req.query.branch_id) { vals.push(req.query.branch_id); where.push(`branch_id=$${vals.length}`); }
    if (req.query.room_type) { vals.push(req.query.room_type); where.push(`room_type=$${vals.length}`); }
    const rooms = await q(`SELECT id,name,room_type FROM rooms WHERE ${where.join(' AND ')} ORDER BY sort_order,id`, vals);
    const out = [];
    for (const r of rooms) {
      const sched = await scheduleForRoom(r.id, date);
      const { slots, occupancy_percent } = buildSlots(sched, await apptsForRoom(r.id, date), await blocksForRoom(r.id, date));
      out.push({ id: r.id, name: r.name, room_type: r.room_type, slots, occupancy_percent });
    }
    res.json({ date, rooms: out });
  } catch (e) { console.error('[rooms] availability:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /find-available — подобрать свободный кабинет для записи
router.post('/find-available', async (req, res) => {
  try {
    const { branch_id, service_id, datetime, duration, preferred_room_id, service_type } = req.body || {};
    if (!datetime || !duration) return res.status(400).json({ error: 'datetime та duration обовʼязкові' });
    const start = new Date(datetime);
    const date = start.toISOString().slice(0, 10);
    const sMin = start.getHours() * 60 + start.getMinutes();
    const eMin = sMin + Number(duration);
    const where = ['deleted_at IS NULL', "status='active'"]; const vals = [];
    if (branch_id) { vals.push(branch_id); where.push(`branch_id=$${vals.length}`); }
    const rooms = await q(`SELECT * FROM rooms WHERE ${where.join(' AND ')} ORDER BY sort_order,id`, vals);
    const available = [];
    for (const r of rooms) {
      const appts = await apptsForRoom(r.id, date);
      const blocks = await blocksForRoom(r.id, date);
      const overlap = appts.some(a => a._s < eMin && a._e > sMin) || blocks.some(b => b._s < eMin && b._e > sMin);
      if (overlap) continue;
      // совместимость по типу услуги
      let match = 1;
      const compat = Array.isArray(r.compatible_service_types) ? r.compatible_service_types : [];
      if (service_type && compat.length && !compat.includes(service_type)) continue;
      if (preferred_room_id && r.id === Number(preferred_room_id)) match = 100;
      else if (service_type && compat.includes(service_type)) match = 50;
      available.push({ id: r.id, name: r.name, room_type: r.room_type, match_score: match });
    }
    available.sort((a, b) => b.match_score - a.match_score);
    res.json({ available_rooms: available, suggested: available[0] ? { id: available[0].id, name: available[0].name } : null });
  } catch (e) { console.error('[rooms] find-available:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /dashboard?branch_id= — сводка по кабинетам
router.get('/dashboard', async (req, res) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const where = ['deleted_at IS NULL']; const vals = [];
    if (req.query.branch_id) { vals.push(req.query.branch_id); where.push(`branch_id=$${vals.length}`); }
    const rooms = await q(`SELECT id,name,status FROM rooms WHERE ${where.join(' AND ')}`, vals);
    let sumOcc = 0, busiest = null, least = null;
    for (const r of rooms.filter(x => x.status === 'active')) {
      const sched = await scheduleForRoom(r.id, date);
      const { occupancy_percent } = buildSlots(sched, await apptsForRoom(r.id, date), await blocksForRoom(r.id, date));
      sumOcc += occupancy_percent;
      if (!busiest || occupancy_percent > busiest.occupancy_percent) busiest = { id: r.id, name: r.name, occupancy_percent };
      if (!least || occupancy_percent < least.occupancy_percent) least = { id: r.id, name: r.name, occupancy_percent };
    }
    const active = rooms.filter(x => x.status === 'active').length;
    res.json({
      total_rooms: rooms.length, active,
      maintenance: rooms.filter(x => x.status === 'maintenance').length,
      avg_occupancy: active ? +(sumOcc / active).toFixed(1) : 0,
      busiest_room: busiest, least_busy_room: least,
    });
  } catch (e) { console.error('[rooms] dashboard:', e.message); res.status(500).json({ error: e.message }); }
});

// ═══ РЕЕСТР ══════════════════════════════════════════════════════════════════

// GET / — список помещений с фильтрами
router.get('/', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const where = ['deleted_at IS NULL']; const vals = [];
    if (!all) where.push(`status='active'`);
    if (req.query.branch_id) { vals.push(req.query.branch_id); where.push(`branch_id=$${vals.length}`); }
    if (req.query.room_type) { vals.push(req.query.room_type); where.push(`room_type=$${vals.length}`); }
    if (req.query.status) { vals.push(req.query.status); where.push(`status=$${vals.length}`); }
    if (req.query.floor) { vals.push(req.query.floor); where.push(`floor=$${vals.length}`); }
    if (req.query.search) { vals.push(`%${req.query.search}%`); where.push(`name ILIKE $${vals.length}`); }
    const sort = ['name', 'room_type', 'capacity', 'sort_order'].includes(req.query.sort) ? req.query.sort : 'sort_order';
    const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const items = await q(
      `SELECT * FROM rooms WHERE ${where.join(' AND ')} ORDER BY ${sort} ${order}, id LIMIT ${limit} OFFSET ${offset}`, vals);
    const total = (await q(`SELECT COUNT(*)::int AS c FROM rooms WHERE ${where.join(' AND ')}`, vals))[0].c;
    res.json({ items, count: items.length, total });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /:id — полная карточка
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const room = (await q(`SELECT * FROM rooms WHERE id=$1 AND deleted_at IS NULL`, [id]))[0];
    if (!room) return res.status(404).json({ error: 'not-found' });
    const equipment = await q(`SELECT * FROM room_equipment WHERE room_id=$1 ORDER BY id`, [id]);
    const schedule = await q(`SELECT * FROM room_schedules WHERE room_id=$1 ORDER BY day_of_week`, [id]);
    const active_blocks = await q(`SELECT * FROM room_blocks WHERE room_id=$1 AND status='active' ORDER BY blocked_from`, [id]);
    const today = new Date().toISOString().slice(0, 10);
    const today_appointments = await q(
      `SELECT id, starts_at, ends_at, status FROM appointments
        WHERE room_id=$1 AND starts_at::date=$2::date AND status NOT IN ('cancelled','noshow')
        ORDER BY starts_at`, [id, today]);
    res.json({ room, equipment, schedule, active_blocks, today_appointments });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST / — создать
router.post('/', W, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const row = (await q(
      `INSERT INTO rooms (name,color,capacity,sort_order,room_type,branch_id,floor,room_number,area_sqm,
         description,internal_note,photo_urls,compatible_service_types,status)
       VALUES ($1,COALESCE($2,'#7c5cff'),COALESCE($3,1),COALESCE($4,0),COALESCE($5,'cabinet'),$6,COALESCE($7,1),
         $8,$9,$10,$11,COALESCE($12,'[]')::jsonb,COALESCE($13,'[]')::jsonb,COALESCE($14,'active'))
       RETURNING *`,
      [b.name, b.color || b.calendar_color || null, b.capacity || null, b.sort_order || null, b.room_type || null,
       b.branch_id || null, b.floor || null, b.room_number || null, b.area_sqm || null, b.description || null,
       b.internal_note || null, JSON.stringify(b.photo_urls || []), JSON.stringify(b.compatible_service_types || []), b.status || null]
    ))[0];
    await logAction({ user: req.user, action: 'room.create', entity: 'room', entity_id: row.id, meta: { name: b.name } });
    res.status(201).json({ ok: true, room: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// PATCH /:id — обновить
router.patch('/:id(\\d+)', W, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const set = [], vals = [];
    const map = {
      name: b.name, color: b.color, capacity: b.capacity, active: b.active, sort_order: b.sort_order,
      room_type: b.room_type, branch_id: b.branch_id, floor: b.floor, room_number: b.room_number,
      area_sqm: b.area_sqm, description: b.description, internal_note: b.internal_note,
      status: b.status, last_repair_date: b.last_repair_date, next_sanitization_date: b.next_sanitization_date,
      qr_code_url: b.qr_code_url,
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) { set.push(`${k}=$${vals.length + 1}`); vals.push(v); }
    if (b.photo_urls !== undefined) { set.push(`photo_urls=$${vals.length + 1}::jsonb`); vals.push(JSON.stringify(b.photo_urls)); }
    if (b.compatible_service_types !== undefined) { set.push(`compatible_service_types=$${vals.length + 1}::jsonb`); vals.push(JSON.stringify(b.compatible_service_types)); }
    if (!set.length) return res.status(400).json({ error: 'нема полів' });
    set.push('updated_at=NOW()'); vals.push(id);
    const row = (await q(`UPDATE rooms SET ${set.join(', ')} WHERE id=$${vals.length} AND deleted_at IS NULL RETURNING *`, vals))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'room.update', entity: 'room', entity_id: id });
    res.json({ ok: true, room: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// DELETE /:id — soft-delete, нельзя если есть будущие записи
router.delete('/:id(\\d+)', W, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const future = (await q(
      `SELECT COUNT(*)::int AS c FROM appointments WHERE room_id=$1 AND starts_at > NOW() AND status NOT IN ('cancelled','noshow')`,
      [id]))[0].c;
    if (future > 0) return res.status(409).json({ error: 'has_future_appointments', count: future });
    await q(`UPDATE rooms SET deleted_at=NOW(), active=FALSE, status='inactive' WHERE id=$1`, [id]);
    await logAction({ user: req.user, action: 'room.delete', entity: 'room', entity_id: id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ═══ ОБОРУДОВАНИЕ ════════════════════════════════════════════════════════════
router.get('/:id(\\d+)/equipment', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM room_equipment WHERE room_id=$1 ORDER BY id`, [req.params.id]) }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.post('/:id(\\d+)/equipment', W, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.equipment_type || !b.name) return res.status(400).json({ error: 'equipment_type та name обовʼязкові' });
    const row = (await q(
      `INSERT INTO room_equipment (room_id,equipment_type,name,model,serial_number,installed_at,last_maintenance,next_maintenance,status,linked_service_ids,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'working'),COALESCE($10,'[]')::jsonb,$11) RETURNING *`,
      [req.params.id, b.equipment_type, b.name, b.model || null, b.serial_number || null, b.installed_at || null,
       b.last_maintenance || null, b.next_maintenance || null, b.status || null, JSON.stringify(b.linked_service_ids || []), b.notes || null]
    ))[0];
    await logAction({ user: req.user, action: 'room.equipment.create', entity: 'room_equipment', entity_id: row.id });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.patch('/:id(\\d+)/equipment/:eqId(\\d+)', W, async (req, res) => {
  try {
    const b = req.body || {}; const set = [], vals = [];
    for (const f of ['equipment_type', 'name', 'model', 'serial_number', 'installed_at', 'last_maintenance', 'next_maintenance', 'status', 'notes']) {
      if (b[f] !== undefined) { set.push(`${f}=$${vals.length + 1}`); vals.push(b[f]); }
    }
    if (b.linked_service_ids !== undefined) { set.push(`linked_service_ids=$${vals.length + 1}::jsonb`); vals.push(JSON.stringify(b.linked_service_ids)); }
    if (!set.length) return res.status(400).json({ error: 'нема полів' });
    set.push('updated_at=NOW()'); vals.push(req.params.eqId); vals.push(req.params.id);
    const row = (await q(`UPDATE room_equipment SET ${set.join(', ')} WHERE id=$${vals.length - 1} AND room_id=$${vals.length} RETURNING *`, vals))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.delete('/:id(\\d+)/equipment/:eqId(\\d+)', W, async (req, res) => {
  try {
    const row = (await q(`DELETE FROM room_equipment WHERE id=$1 AND room_id=$2 RETURNING id`, [req.params.eqId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══ РАСПИСАНИЕ ══════════════════════════════════════════════════════════════
router.get('/:id(\\d+)/schedule', async (req, res) => {
  try {
    const season = req.query.season || 'default';
    res.json({ schedule: await q(`SELECT * FROM room_schedules WHERE room_id=$1 AND season=$2 ORDER BY day_of_week`, [req.params.id, season]) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.put('/:id(\\d+)/schedule', W, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const season = b.season || 'default';
    const validFrom = b.valid_from || '2000-01-01';
    if (!Array.isArray(b.days)) return res.status(400).json({ error: 'days[] обовʼязкові' });
    await q(`DELETE FROM room_schedules WHERE room_id=$1 AND season=$2 AND valid_from=$3`, [id, season, validFrom]);
    for (const d of b.days) {
      if (d.day_of_week == null) continue;
      await q(
        `INSERT INTO room_schedules (room_id,day_of_week,open_time,close_time,break_start,break_end,cleanup_interval,is_day_off,season,valid_from,valid_until)
         VALUES ($1,$2,COALESCE($3,'09:00'),COALESCE($4,'21:00'),$5,$6,COALESCE($7,0),COALESCE($8,FALSE),$9,$10,$11)
         ON CONFLICT (room_id,day_of_week,season,valid_from) DO UPDATE SET
           open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time, break_start=EXCLUDED.break_start,
           break_end=EXCLUDED.break_end, cleanup_interval=EXCLUDED.cleanup_interval, is_day_off=EXCLUDED.is_day_off,
           valid_until=EXCLUDED.valid_until, updated_at=NOW()`,
        [id, d.day_of_week, d.open_time || null, d.close_time || null, d.break_start || null, d.break_end || null,
         d.cleanup_interval || null, d.is_day_off ?? null, season, validFrom, b.valid_until || null]
      );
    }
    await logAction({ user: req.user, action: 'room.schedule.update', entity: 'room', entity_id: id });
    res.json({ ok: true, schedule: await q(`SELECT * FROM room_schedules WHERE room_id=$1 AND season=$2 ORDER BY day_of_week`, [id, season]) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══ БЛОКИРОВКИ ══════════════════════════════════════════════════════════════
router.get('/:id(\\d+)/blocks', async (req, res) => {
  try {
    const where = ['room_id=$1']; const vals = [req.params.id];
    if (req.query.status) { vals.push(req.query.status); where.push(`status=$${vals.length}`); }
    if (req.query.from) { vals.push(req.query.from); where.push(`blocked_until >= $${vals.length}`); }
    if (req.query.to) { vals.push(req.query.to); where.push(`blocked_from <= $${vals.length}`); }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const items = await q(`SELECT * FROM room_blocks WHERE ${where.join(' AND ')} ORDER BY blocked_from DESC LIMIT ${limit}`, vals);
    const total = (await q(`SELECT COUNT(*)::int AS c FROM room_blocks WHERE ${where.join(' AND ')}`, vals))[0].c;
    res.json({ items, total });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.post('/:id(\\d+)/blocks', W, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!b.block_type || !b.reason || !b.blocked_from || !b.blocked_until)
      return res.status(400).json({ error: 'block_type, reason, blocked_from, blocked_until обовʼязкові' });
    // конфликты с записями
    const conflicts = await q(
      `SELECT a.id AS appointment_id, a.starts_at AS datetime, COALESCE(c.name,'') AS client_name
         FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
        WHERE a.room_id=$1 AND a.status NOT IN ('cancelled','noshow')
          AND a.starts_at < $3 AND a.ends_at > $2
        ORDER BY a.starts_at`,
      [id, b.blocked_from, b.blocked_until]
    );
    const row = (await q(
      `INSERT INTO room_blocks (room_id,block_type,reason,blocked_from,blocked_until,blocked_by,affected_appointments,auto_reschedule,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,FALSE),$9) RETURNING *`,
      [id, b.block_type, b.reason, b.blocked_from, b.blocked_until, b.blocked_by || null, conflicts.length, b.auto_reschedule, b.notes || null]
    ))[0];
    if (b.auto_reschedule && conflicts.length) {
      // снимаем кабинет с конфликтующих записей (перенос в "без кабинета" — администратор переназначит)
      await q(`UPDATE appointments SET room_id=NULL WHERE id = ANY($1)`, [conflicts.map(c => c.appointment_id)]);
    }
    await logAction({ user: req.user, action: 'room.block.create', entity: 'room_block', entity_id: row.id, meta: { affected: conflicts.length } });
    res.status(201).json({ id: row.id, ...row, affected_appointments: conflicts.length, conflicts });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.patch('/:id(\\d+)/blocks/:blockId(\\d+)', W, async (req, res) => {
  try {
    const b = req.body || {}; const set = [], vals = [];
    for (const f of ['blocked_until', 'status', 'notes', 'reason', 'auto_reschedule']) {
      if (b[f] !== undefined) { set.push(`${f}=$${vals.length + 1}`); vals.push(b[f]); }
    }
    if (b.status === 'completed') set.push('completed_at=NOW()');
    if (!set.length) return res.status(400).json({ error: 'нема полів' });
    set.push('updated_at=NOW()'); vals.push(req.params.blockId); vals.push(req.params.id);
    const row = (await q(`UPDATE room_blocks SET ${set.join(', ')} WHERE id=$${vals.length - 1} AND room_id=$${vals.length} RETURNING *`, vals))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
router.delete('/:id(\\d+)/blocks/:blockId(\\d+)', W, async (req, res) => {
  try {
    const row = (await q(`UPDATE room_blocks SET status='cancelled', updated_at=NOW() WHERE id=$1 AND room_id=$2 RETURNING id`, [req.params.blockId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══ ДОСТУПНОСТЬ ОДНОГО КАБИНЕТА ═════════════════════════════════════════════
router.get('/:id(\\d+)/availability', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sched = await scheduleForRoom(id, date);
    const { slots, occupancy_percent } = buildSlots(sched, await apptsForRoom(id, date), await blocksForRoom(id, date));
    res.json({ date, slots, occupancy_percent });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══ АНАЛИТИКА КАБИНЕТА ══════════════════════════════════════════════════════
router.get('/:id(\\d+)/analytics', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const days = parseInt(String(req.query.period || '30d'), 10) || 30;
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const appts = await q(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at-starts_at))/3600),0)::numeric AS busy_hours,
              COALESCE(EXTRACT(HOUR FROM starts_at),0) AS hr
         FROM appointments
        WHERE room_id=$1 AND starts_at::date >= $2 AND status NOT IN ('cancelled','noshow')
        GROUP BY hr ORDER BY COUNT(*) DESC`, [id, since]);
    const totalAppt = appts.reduce((s, r) => s + Number(r.total), 0);
    const busyHours = appts.reduce((s, r) => s + Number(r.busy_hours), 0);
    const peak = appts.slice(0, 3).map(r => `${String(r.hr).padStart(2, '0')}:00`);
    const blocks = (await q(`SELECT COUNT(*)::int AS c FROM room_blocks WHERE room_id=$1 AND blocked_from::date >= $2`, [id, since]))[0].c;
    const revenue = (await q(
      `SELECT COALESCE(SUM(s.price),0)::numeric AS rev
         FROM appointments a LEFT JOIN services s ON s.id=a.service_id
        WHERE a.room_id=$1 AND a.starts_at::date >= $2 AND a.status IN ('done','confirmed')`, [id, since]))[0].rev;
    // примерный % загрузки: busy_hours / (рабочие 12ч * days)
    const occ = +(busyHours / (12 * days) * 100).toFixed(1);
    res.json({
      period_days: days, occupancy_percent: occ, peak_hours: peak,
      total_appointments: totalAppt, total_blocks: blocks,
      revenue_attributed: Number(revenue),
      avg_idle_time: totalAppt ? +((12 * days - busyHours) / totalAppt).toFixed(1) : null,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
