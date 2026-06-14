/* Schedule: расписание мастеров — CRUD + синк с BeautyPro
   Подключается как /api/schedule */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { getSetting, maskPhone } = require('../lib/settings');
const hub = require('../lib/notification-hub');
const router = express.Router();

// GET = schedule.read, мутации = schedule.write
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'schedule.read' : 'schedule.write';
  return requirePerm(perm)(req, res, next);
});

// ── GET /api/schedule/masters — мастера с расписанием ──
// ?all=1 — включить уволенных (для управления карточками). По умолчанию только активные.
router.get('/masters', async (req, res) => {
  try {
    const pool = getPool();
    const all = req.query.all === '1' || req.query.all === 'true';
    const r = await pool.query(
      `SELECT id, name, specialty, avatar, schedule_json, active, beautypro_id
         FROM masters ${all ? '' : 'WHERE active = true'} ORDER BY active DESC, name`
    );
    // Типовий тижневий графік: агрегуємо реальні зміни з BeautyPro (master_schedule_days)
    // за вікно [-7..+35 днів] по днях тижня — найчастіша зміна per день стає шаблоном.
    // BeautyPro має пріоритет над ручним schedule_json (єдина правда, як у журналі).
    const DAYK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // індекс = EXTRACT(DOW)
    const bp = await pool.query(
      `SELECT master_id, EXTRACT(DOW FROM work_date)::int AS dow,
              to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
         FROM master_schedule_days
        WHERE work_date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE + 35
          AND start_time IS NOT NULL`
    );
    // master -> weekday -> { 'HH:MM-HH:MM': count }
    const agg = new Map();
    for (const row of bp.rows) {
      if (!agg.has(row.master_id)) agg.set(row.master_id, {});
      const wd = agg.get(row.master_id);
      const key = DAYK[row.dow];
      const slot = `${row.start}-${row.end}`;
      wd[key] = wd[key] || {};
      wd[key][slot] = (wd[key][slot] || 0) + 1;
    }

    // BeautyPro формально віддає графік лише для 2 майстрів (решта працюють,
    // але графік у BP не заведений). Щоб дошка була повна і ПРАВДИВА — для решти
    // виводимо реальні робочі години з фактичних записів: для кожного дня тижня
    // беремо найраніший початок і найпізніший кінець записів за останні 8 тижнів,
    // якщо майстер працював у цей день ≥2 різних дат (відсікає випадкові одиничні).
    const realRes = await pool.query(
      `SELECT master_id, EXTRACT(DOW FROM (starts_at AT TIME ZONE 'Europe/Kyiv'))::int AS dow,
              to_char(MIN((starts_at AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS start,
              to_char(MAX((COALESCE(ends_at, starts_at + interval '1 hour') AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS end,
              COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kyiv')::date) AS days
         FROM appointments
        WHERE starts_at >= CURRENT_DATE - 56 AND starts_at < CURRENT_DATE + 35
          AND master_id IS NOT NULL
          AND COALESCE(status,'') NOT IN ('cancelled','noshow')
        GROUP BY master_id, dow
       HAVING COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kyiv')::date) >= 2`
    );
    const real = new Map(); // master -> { mon: {start,end} }
    for (const row of realRes.rows) {
      if (!real.has(row.master_id)) real.set(row.master_id, {});
      real.get(row.master_id)[DAYK[row.dow]] = { start: row.start, end: row.end };
    }

    const items = r.rows.map((m) => {
      const tmpl = m.schedule_json || {};
      const wd = agg.get(m.id) || {};
      const rl = real.get(m.id) || {};
      const week = {};
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].forEach((k) => {
        if (wd[k]) {
          // найчастіша зміна для цього дня тижня (графік BeautyPro — пріоритет)
          const best = Object.entries(wd[k]).sort((a, b) => b[1] - a[1])[0][0];
          const [start, end] = best.split('-');
          week[k] = { start, end, source: 'beautypro' };
        } else if (tmpl[k]) {
          week[k] = { start: tmpl[k].start, end: tmpl[k].end,
            break_start: tmpl[k].break_start || null, break_end: tmpl[k].break_end || null, source: 'template' };
        } else if (rl[k]) {
          // фактичні робочі години з записів (BP графік відсутній)
          week[k] = { start: rl[k].start, end: rl[k].end, source: 'auto' };
        } else { week[k] = null; }
      });
      return { ...m, week };
    });
    res.json({ items, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/schedule/masters/:id — сменить статус (работает/уволен) ──
// Body: { active: true|false }. Уволенный мастер исчезает из журнала, графика,
// онлайн-записи и всех выпадающих списков, но остаётся для статистики (отчёты тянут всех).
router.patch('/masters/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active boolean required' });
    const r = await pool.query(
      'UPDATE masters SET active = $1 WHERE id = $2 RETURNING id, name, active',
      [active, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json({ ok: true, master: r.rows[0] });
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

// ── GET /api/schedule/masters/:id/portfolio — портфолио мастера (профиль + статистика) ──
router.get('/masters/:id/portfolio', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const m = await pool.query('SELECT * FROM masters WHERE id = $1', [id]);
    if (!m.rows[0]) return res.status(404).json({ error: 'master not found' });
    // Статистика — з каси (реально оплачене). BeautyPro не присилає статус 'done',
    // тому рахуємо за cash_operations(sale_service/sale_product), а не за appointments.status.
    const stat = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM cash_operations
            WHERE master_id=$1 AND type='in' AND category='sale_service')::int AS done_total,
         (SELECT COALESCE(SUM(amount),0) FROM cash_operations
            WHERE master_id=$1 AND type='in' AND category IN ('sale_service','sale_product'))::float AS revenue_total,
         (SELECT COUNT(*) FROM cash_operations
            WHERE master_id=$1 AND type='in' AND category='sale_service'
              AND created_at >= NOW() - INTERVAL '30 days')::int AS done_30,
         (SELECT COALESCE(SUM(amount),0) FROM cash_operations
            WHERE master_id=$1 AND type='in' AND category IN ('sale_service','sale_product')
              AND created_at >= NOW() - INTERVAL '30 days')::float AS revenue_30,
         (SELECT COUNT(DISTINCT client_id) FROM appointments WHERE master_id=$1)::int AS clients_total`,
      [id]);
    const topServices = await pool.query(
      `SELECT COALESCE(NULLIF(description,''),'Послуга') AS service, COUNT(*)::int AS cnt,
              COALESCE(SUM(amount),0)::float AS sum
         FROM cash_operations
        WHERE master_id = $1 AND type='in' AND category='sale_service'
        GROUP BY 1 ORDER BY sum DESC LIMIT 10`, [id]);
    const recent = await pool.query(
      `SELECT a.id, a.starts_at, a.status, a.price, a.services_text,
              COALESCE(a.client_name, c.name) AS client_name
         FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.master_id = $1 ORDER BY a.starts_at DESC NULLS LAST LIMIT 30`, [id]);
    res.json({ ok: true, master: m.rows[0], stats: stat.rows[0],
               top_services: topServices.rows, recent: recent.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/schedule/masters/:id/profile — редактирование профиля мастера ──
// Body: { name, specialty, bio, phone, commission_pct }
router.patch('/masters/:id/profile', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'specialty', 'bio', 'phone', 'commission_pct'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
        let v = req.body[f];
        if (f === 'commission_pct' && (v === '' || v == null)) v = null;
        vals.push(v); sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    vals.push(id);
    const r = await pool.query(
      `UPDATE masters SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json({ ok: true, master: r.rows[0] });
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
    // Зберігаємо разові винятки (відгули), щоб оновлення тижневого графіка їх не стирало
    const cur = await pool.query('SELECT schedule_json FROM masters WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'master not found' });
    const existing = cur.rows[0].schedule_json || {};
    if (existing.exceptions && typeof existing.exceptions === 'object') clean.exceptions = existing.exceptions;
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

    // Майстер бачить лише власний графік і власні записи
    const masterOnly = (req.user && req.user.role === 'master' && req.user.master_id) ? Number(req.user.master_id) : null;

    // майстри + їх робочий час на цей день тижня
    const mRes = await pool.query(
      `SELECT id, name, specialty, avatar, schedule_json FROM masters
        WHERE active = true ${masterOnly ? 'AND id = $1' : ''} ORDER BY name`,
      masterOnly ? [masterOnly] : []
    );
    // реальний графік з BeautyPro на цю дату (пріоритет над тижневим schedule_json)
    const bpRes = await pool.query(
      `SELECT master_id, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
         FROM master_schedule_days WHERE work_date = $1`, [date]
    );
    const bpMap = new Map(bpRes.rows.map(r => [r.master_id, r]));
    const masters = mRes.rows.map(m => {
      const s = m.schedule_json || {};
      const bp = bpMap.get(m.id);
      if (bp) {
        // BeautyPro має запис на цей день: є години → працює, немає → вихідний
        const working = !!(bp.start && bp.end);
        return {
          id: m.id, name: m.name, specialty: m.specialty, avatar: m.avatar,
          working, start: working ? bp.start : null, end: working ? bp.end : null,
          break_start: null, break_end: null,
          day_off_reason: working ? null : 'Вихідний',
        };
      }
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
      `SELECT a.id, a.master_id, a.service_id, a.client_id, a.room_id,
              a.starts_at, a.ends_at, a.status, a.notes,
              COALESCE(a.price, s.price) AS price,
              s.name AS service_name,
              COALESCE(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at))/60, s.duration_min) AS duration_min,
              m.name AS master_name,
              -- Оплата = ПРАВДА: вручну (ref_type=appointment) АБО конкретний продаж послуги
              -- у BeautyPro цьому ж клієнту тим же майстром того ж дня (точна привʼязка по GUID).
              -- Без bp_client (не злінкований клієнт) — НЕ показуємо «оплачено» (краще пропуск, ніж брехня).
              (EXISTS(SELECT 1 FROM cash_operations co
                        WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id)
               OR (a.bp_client IS NOT NULL AND a.master_id IS NOT NULL AND EXISTS(SELECT 1 FROM cash_operations co
                        WHERE co.type='in' AND co.ref_type='bp_sale' AND co.category='sale_service'
                          AND co.bp_client = a.bp_client AND co.master_id = a.master_id
                          AND (COALESCE(co.bp_calendar, co.created_at) AT TIME ZONE 'Europe/Kyiv')::date
                              = (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date))
              ) AS paid,
              COALESCE(
                NULLIF(c.name,''),
                CASE WHEN a.bp_client ~* '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN NULL ELSE a.bp_client END,
                'Клієнт'
              ) AS client_name,
              c.phone AS client_phone,
              -- історія клієнта: попередні візити та неявки (для прапорців «новий» / «⚠ не прийшов»)
              CASE WHEN a.client_id IS NULL THEN NULL ELSE (
                SELECT COUNT(*)::int FROM appointments av
                 WHERE av.client_id = a.client_id AND av.starts_at < a.starts_at
                   AND COALESCE(av.status,'') NOT IN ('cancelled','noshow')
              ) END AS visit_count,
              CASE WHEN a.client_id IS NULL THEN 0 ELSE (
                SELECT COUNT(*)::int FROM appointments av
                 WHERE av.client_id = a.client_id AND av.status = 'noshow'
              ) END AS no_show_count
         FROM appointments a
         LEFT JOIN masters  m ON m.id = a.master_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN clients  c ON c.id = a.client_id
        WHERE a.starts_at >= $1::date
          AND a.starts_at <  ($1::date + INTERVAL '1 day')
          AND COALESCE(a.status,'') NOT IN ('cancelled')
          ${masterOnly ? 'AND a.master_id = $2' : ''}
        ORDER BY a.starts_at`,
      masterOnly ? [date, masterOnly] : [date]
    );

    // Майстер не бачить номери клієнтів, якщо опція вимкнена
    let appts = aRes.rows;
    if (req.user && req.user.role === 'master') {
      const see = await getSetting('masters_see_phone', false);
      if (see !== true) appts = appts.map(a => ({ ...a, client_phone: maskPhone(a.client_phone), phone_hidden: true }));
    }

    res.json({ date, day: dayKey, masters, appointments: appts, count: appts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/schedule/appointments/:id — заметка / статус ──
router.patch('/appointments/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { notes, status, room_id, starts_at, master_id } = req.body || {};
    if (notes === undefined && status === undefined && room_id === undefined
        && starts_at === undefined && master_id === undefined) {
      return res.status(400).json({ error: 'nothing-to-update' });
    }
    const allowed = ['booked', 'confirmed', 'done', 'cancelled', 'noshow'];
    if (status !== undefined && !allowed.includes(status)) {
      return res.status(400).json({ error: 'bad-status' });
    }

    // Перенос запису (drag&drop): нове starts_at → зберігаємо тривалість, перераховуємо ends_at
    let newStart = null, newEnd = null;
    if (starts_at !== undefined) {
      const sd = new Date(starts_at);
      if (isNaN(sd)) return res.status(400).json({ error: 'bad-starts_at' });
      const cur = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (ends_at - starts_at))/60 AS dur FROM appointments WHERE id=$1`,
        [req.params.id]
      );
      if (!cur.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
      const dur = Number(cur.rows[0].dur) || 30;
      newStart = sd.toISOString();
      newEnd = new Date(sd.getTime() + dur * 60000).toISOString();
    }

    const r = await pool.query(
      `UPDATE appointments
          SET notes = COALESCE($2, notes),
              status = COALESCE($3, status),
              room_id = COALESCE($4, room_id),
              master_id = COALESCE($5, master_id),
              starts_at = COALESCE($6, starts_at),
              ends_at = COALESCE($7, ends_at),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, notes, status, room_id, master_id, starts_at, ends_at`,
      [req.params.id, notes ?? null, status ?? null, room_id ?? null,
       master_id != null ? Number(master_id) : null, newStart, newEnd]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });

    // услуга выполнена → списываем расходники со склада (идемпотентно)
    let stock = null;
    if (status === 'done') {
      try {
        const { writeOffForAppointment } = require('../lib/consumables');
        stock = await writeOffForAppointment(Number(req.params.id));
      } catch (e) { stock = { written: false, error: e.message }; }
    }
    res.json({ ok: true, appointment: r.rows[0], stock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/schedule/appointments — створення запису адміном «в моменті» ──
router.post('/appointments', async (req, res) => {
  try {
    const pool = getPool();
    let { master_id, service_id, starts_at, ends_at, client_id, client_name, client_phone, room_id, notes } = req.body || {};
    if (!master_id || !service_id || !starts_at) {
      return res.status(400).json({ error: 'master_id, service_id, starts_at обовʼязкові' });
    }
    // послуга → ціна + тривалість
    const sv = await pool.query('SELECT price, duration_min, name FROM services WHERE id=$1', [Number(service_id)]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'service-not-found' });
    const dur = Number(sv.rows[0].duration_min) || 30;
    const startDate = new Date(starts_at);
    if (isNaN(startDate)) return res.status(400).json({ error: 'bad-starts_at' });
    const endDate = ends_at ? new Date(ends_at) : new Date(startDate.getTime() + dur * 60000);

    // клієнт: за id, або за телефоном (знайти/створити), або тільки імʼя
    let cid = client_id ? Number(client_id) : null;
    if (!cid && client_phone) {
      const digits = String(client_phone).replace(/\D/g, '');
      if (digits) {
        const ex = await pool.query('SELECT id FROM clients WHERE phone=$1', [digits]);
        if (ex.rows[0]) cid = ex.rows[0].id;
        else {
          const nc = await pool.query(
            `INSERT INTO clients (phone, name, source) VALUES ($1,$2,'salon') RETURNING id`,
            [digits, client_name || null]
          );
          cid = nc.rows[0].id;
        }
      }
    } else if (!cid && client_name) {
      const nc = await pool.query(
        `INSERT INTO clients (name, source) VALUES ($1,'salon') RETURNING id`, [client_name]
      );
      cid = nc.rows[0].id;
    }

    const r = await pool.query(
      `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, source, room_id, notes)
       VALUES ($1,$2,$3,$4,$5,'booked',$6,'admin',$7,$8)
       RETURNING id`,
      [cid, Number(master_id), Number(service_id), startDate.toISOString(), endDate.toISOString(),
       sv.rows[0].price, room_id ? Number(room_id) : null, notes || null]
    );
    // Подтверждение клиенту через Notification Hub (не блокирует ответ).
    if (cid) {
      const time = startDate.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
      const date = startDate.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
      const mname = await pool.query(`SELECT name FROM masters WHERE id=$1`, [Number(master_id)]).then(x => x.rows[0]?.name || '').catch(() => '');
      hub.enqueue({
        clientId: cid, templateKey: 'appt_confirm', priority: 'high', category: 'transactional',
        source: 'schedule', dedupKey: `appt:${r.rows[0].id}:confirm`,
        vars: { date, time, master: mname, service: sv.rows[0].name || '' },
      }).catch(e => console.error('[schedule] confirm enqueue:', e.message));
    }
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/schedule/appointments/:id/pay — провести оплату ──
// Помічає запис виконаним + створює прихід у касу (готівка/картка).
// Ідемпотентно: повторний виклик не дублює операцію (ref_type='appointment').
router.post('/appointments/:id/pay', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const method = ['cash', 'card', 'transfer', 'mono'].includes(req.body?.method) ? req.body.method : 'cash';

    // запис + ціна + майстер + GUID клієнта (для точної перевірки оплати в BP)
    const ap = await pool.query(
      `SELECT a.id, a.master_id, a.client_id, a.status, a.bp_client, a.starts_at,
              COALESCE(a.price, s.price) AS price, s.name AS service_name
         FROM appointments a LEFT JOIN services s ON s.id = a.service_id
        WHERE a.id = $1`, [id]
    );
    if (!ap.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    const appt = ap.rows[0];
    const amount = Number(appt.price) || 0;
    if (amount <= 0) return res.status(400).json({ error: 'no-price', message: 'У запису не вказана ціна послуги' });

    // вже оплачено вручну? (ідемпотентність)
    const dup = await pool.query(
      `SELECT id FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in' LIMIT 1`, [id]
    );
    if (dup.rows[0]) {
      await pool.query(`UPDATE appointments SET status='done', updated_at=NOW() WHERE id=$1 AND status<>'done'`, [id]);
      return res.json({ ok: true, already_paid: true, operation_id: dup.rows[0].id });
    }
    // вже оплачено в BeautyPro? Конкретний продаж послуги цьому клієнту тим же
    // майстром того ж дня (точна привʼязка по GUID) — гроші вже в касі. Не дублюємо.
    if (appt.master_id && appt.bp_client) {
      const bp = await pool.query(
        `SELECT id FROM cash_operations
          WHERE type='in' AND ref_type='bp_sale' AND category='sale_service'
            AND master_id=$1 AND bp_client=$2
            AND (COALESCE(bp_calendar, created_at) AT TIME ZONE 'Europe/Kyiv')::date
                = ($3::timestamptz AT TIME ZONE 'Europe/Kyiv')::date
          LIMIT 1`, [appt.master_id, appt.bp_client, appt.starts_at]
      );
      if (bp.rows[0]) {
        await pool.query(`UPDATE appointments SET status='done', updated_at=NOW() WHERE id=$1 AND status<>'done'`, [id]);
        return res.json({ ok: true, already_paid: true, paid_via: 'beautypro', operation_id: bp.rows[0].id });
      }
    }

    // відкрита зміна каси
    const sh = await pool.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
    if (!sh.rows[0]) return res.status(400).json({ error: 'no-open-shift', message: 'Немає відкритої зміни каси. Відкрийте зміну в розділі «Каса».' });
    const shiftId = sh.rows[0].id;

    // прихід у касу
    const op = await pool.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
       VALUES ($1,'in','sale_service',$2,$3,'appointment',$4,$5,$6) RETURNING id`,
      [shiftId, amount, method, id, appt.master_id || null, appt.service_name || 'Послуга']
    );

    // запис виконано + списання розхідників (ідемпотентно)
    await pool.query(`UPDATE appointments SET status='done', updated_at=NOW() WHERE id=$1`, [id]);
    let stock = null;
    try {
      const { writeOffForAppointment } = require('../lib/consumables');
      stock = await writeOffForAppointment(id);
    } catch (e) { stock = { written: false, error: e.message }; }

    res.json({ ok: true, operation_id: op.rows[0].id, amount, method, stock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/schedule/appointments/:id — видалити запис ──
// Прибирає касові операції цього запису у ВІДКРИТІЙ зміні, потім видаляє сам запис.
router.delete('/appointments/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const chk = await pool.query(`SELECT id FROM appointments WHERE id=$1`, [id]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    // прибрати привʼязані касові операції лише з відкритих змін (минулі не чіпаємо)
    await pool.query(
      `DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1
         AND shift_id IN (SELECT id FROM cash_shifts WHERE status='open')`, [id]
    );
    await pool.query(`DELETE FROM appointments WHERE id=$1`, [id]);
    res.json({ ok: true, deleted: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
