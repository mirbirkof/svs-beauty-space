/* Schedule: расписание мастеров — CRUD + синк с BeautyPro
   Подключается как /api/schedule */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { getSetting, maskPhone, shouldMaskPhones } = require('../lib/settings');
const hub = require('../lib/notification-hub');
const { buildMonthGrid } = require('../lib/schedule-month');
const { findOverlap } = require('../lib/booking-guard');
const { normalizePhoneDb } = require('../lib/phone');
const { emit: emitEvent } = require('../lib/event-bus');
const router = express.Router();

// Единая точка эмита события «визит завершён». Подписчик lib/report-cache.js
// сбрасывает кэш отчётов → цифры в отчётах/дашборде/аналитике обновляются сразу.
// В try/catch: эмит НИКОГДА не должен ронять оплату/закрытие записи.
async function emitAppt(eventType, apptId, masterId) {
  try {
    await emitEvent(eventType,
      { appointment_id: Number(apptId), master_id: masterId || null },
      { entityType: 'appointment', entityId: apptId });
  } catch (e) { console.error(`[schedule] emit ${eventType} failed:`, e.message); }
}
const emitAppointmentCompleted = (id, m) => emitAppt('appointment.completed', id, m);

// ── #95: замок на редагування минулих днів журналу ──
// Адмін/менеджер можуть правити записи минулих днів лише коли увімкнено налаштування
// allow_edit_past (Налаштування → Графік змін). Власник може завжди.
// «Минулий день» = календарний день (за Києвом) раніше сьогоднішнього.
const PAST_LOCKED = { error: 'past-locked', message: 'Редагування минулих днів вимкнено. Власник може увімкнути це в Налаштуваннях → Графік змін.' };
const _kyivYmd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
async function pastEditDenied(req, dateLike) {
  try {
    if (!dateLike) return false;
    if (((req.user && req.user.role) || '') === 'owner') return false;
    const day = _kyivYmd(dateLike);
    if (day === 'Invalid Date' || day >= _kyivYmd(new Date())) return false;
    return (await getSetting('allow_edit_past', false)) !== true;
  } catch { return false; } // збій перевірки не має блокувати роботу журналу
}

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
      `SELECT m.id, m.name, m.specialty, m.avatar, m.schedule_json, m.active, m.beautypro_id,
              COALESCE(m.provides_services, true) AS provides_services, m.staff_role,
              u.id AS user_id, rr.code AS login_role, rr.name AS login_role_name,
              (u.id IS NOT NULL) AS has_login
         FROM masters m
         LEFT JOIN users u ON u.master_id = m.id AND u.is_active
         LEFT JOIN roles rr ON rr.id = u.role_id
        WHERE COALESCE(m.provides_services, true) = true ${all ? '' : 'AND m.active = true'}
        ORDER BY m.active DESC, m.name`
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/schedule/masters/:id — один мастер с расписанием ──
router.get('/masters/:id', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query('SELECT * FROM masters WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/schedule/masters/:id/profile — редактирование профиля мастера ──
// Body: { name, specialty, bio, phone, commission_pct }
router.patch('/masters/:id/profile', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'surname', 'email', 'category', 'specialty', 'bio', 'phone', 'avatar', 'commission_pct', 'provides_services', 'staff_role',
      // онлайн-запис
      'online_booking_enabled', 'online_rank', 'online_title', 'online_description',
      // оповіщення
      'notify_channel', 'notify_telegram', 'notify_new_booking', 'notify_cancellation', 'notify_reschedule'];
    const boolFields = new Set(['provides_services', 'online_booking_enabled', 'notify_new_booking', 'notify_cancellation', 'notify_reschedule']);
    // Поля з UNIQUE-обмеженням або просто необов'язкові: порожній рядок → NULL.
    // phone входить у unique (tenant_id, phone) — два майстри з phone='' падали в 23505
    // duplicate key, через що ламалося збереження ВСЬОГО профілю (зокрема імені). NULL
    // не конфліктує в unique-індексі, тож майстрів без телефону можна редагувати вільно.
    const nullIfEmpty = new Set(['phone', 'email', 'category', 'surname', 'avatar', 'bio', 'online_title', 'online_description', 'notify_telegram']);
    const sets = [], vals = [];
    for (const f of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
        let v = req.body[f];
        if (f === 'commission_pct' && (v === '' || v == null)) v = null;
        if (f === 'online_rank') v = (v === '' || v == null) ? 0 : parseInt(v, 10) || 0;
        if (boolFields.has(f)) v = !!v;
        if (nullIfEmpty.has(f) && typeof v === 'string' && v.trim() === '') v = null;
        vals.push(v); sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    vals.push(id);
    const r = await pool.query(
      `UPDATE masters SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'master not found' });
    res.json({ ok: true, master: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/schedule/month?ym=YYYY-MM — місячна матриця графіків (як DIKIDI) ──
// Рядки = майстри, колонки = дні місяця, клітинка = зміна (start-end) або вихідний.
// Пріоритет на конкретний день: явний per-day запис (master_schedule_days) >
//   виняток-відгул (schedule_json.exceptions) > тижневий шаблон (beautypro>template>auto).
router.get('/month', async (req, res) => {
  try {
    const pool = getPool();
    const grid = await buildMonthGrid(pool, req.query.ym);
    res.json({ ym: grid.ym, days_in_month: grid.daysInMonth, dates: grid.dates, items: grid.items, count: grid.items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/schedule/day — ручне редагування зміни конкретного дня ──
// Body: { master_id, work_date:"YYYY-MM-DD", start:"09:00", end:"18:00", off:false }
// off:true → вихідний (start_time NULL). source='manual' захищено від перезапису синхронізацією.
router.post('/day', async (req, res) => {
  try {
    const pool = getPool();
    const { master_id, work_date, start, end, off } = req.body || {};
    if (!master_id || !work_date) return res.status(400).json({ error: 'master_id and work_date required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date)) return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
    let st = null, en = null;
    if (!off) {
      if (!/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || '')) return res.status(400).json({ error: 'start/end must be HH:MM' });
      st = start; en = end;
    }
    const r = await pool.query(
      `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
         VALUES ($1,$2,$3,$4,'manual',NOW())
       ON CONFLICT (master_id, work_date)
       DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, source='manual', synced_at=NOW()
       RETURNING id, to_char(work_date,'YYYY-MM-DD') AS work_date,
                 to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end`,
      [master_id, work_date, st, en]);
    res.json({ ok: true, day: r.rows[0], off: !!off });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/schedule/apply-pattern-batch — згенерувати графік на N місяців для КІЛЬКОХ майстрів ──
// Замінює BeautyPro-синк: салон сам тримає графік на місяці вперед.
// Body: { master_ids:[Int] | 'all', months_ahead:Int(1..6), work_days, off_days, anchor:"YYYY-MM-DD",
//         start:"09:00", end:"18:00", from_ym?:"YYYY-MM" (default поточний місяць) }
router.post('/apply-pattern-batch', async (req, res) => {
  try {
    const pool = getPool();
    let { master_ids, months_ahead, work_days, off_days, anchor, start, end } = req.body || {};
    work_days = parseInt(work_days, 10); off_days = parseInt(off_days, 10);
    months_ahead = Math.min(Math.max(parseInt(months_ahead, 10) || 1, 1), 6);
    if (!(work_days >= 1) || !(off_days >= 0)) return res.status(400).json({ error: 'work_days/off_days invalid' });
    if (!/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || '') || end <= start)
      return res.status(400).json({ error: 'bad-time' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) return res.status(400).json({ error: 'anchor YYYY-MM-DD required' });

    // список майстрів
    let ids = master_ids;
    if (ids === 'all' || !Array.isArray(ids) || !ids.length) {
      const m = await pool.query(`SELECT id FROM masters WHERE active IS NOT FALSE AND COALESCE(online_booking_enabled,true) IS NOT FALSE`);
      ids = m.rows.map(r => r.id);
    } else ids = ids.map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'no-masters' });

    // місяці від поточного (або from_ym) на months_ahead уперед
    const fromYm = /^\d{4}-\d{2}$/.test(req.body?.from_ym || '') ? req.body.from_ym
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const [FY, FM] = fromYm.split('-').map(Number);
    const cycle = work_days + off_days;
    const anchorD = new Date(anchor + 'T00:00:00Z');
    const dayMs = 86400000;
    let totalWork = 0, totalOff = 0, mastersDone = 0;

    for (const mid of ids) {
      for (let mo = 0; mo < months_ahead; mo++) {
        const Y = FY + Math.floor((FM - 1 + mo) / 12);
        const M = ((FM - 1 + mo) % 12) + 1;
        const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const cur = new Date(Date.UTC(Y, M - 1, d));
          const iso = cur.toISOString().slice(0, 10);
          let idx = Math.round((cur - anchorD) / dayMs) % cycle; if (idx < 0) idx += cycle;
          if (idx < work_days) {
            await pool.query(
              `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
                 VALUES ($1,$2,$3,$4,'manual',NOW())
               ON CONFLICT (master_id, work_date) DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, source='manual', synced_at=NOW()`,
              [mid, iso, start, end]);
            totalWork++;
          } else {
            await pool.query(
              `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
                 VALUES ($1,$2,NULL,NULL,'manual',NOW())
               ON CONFLICT (master_id, work_date) DO UPDATE SET start_time=NULL, end_time=NULL, source='manual', synced_at=NOW()`,
              [mid, iso]);
            totalOff++;
          }
        }
      }
      mastersDone++;
    }
    res.json({ ok: true, masters: mastersDone, months: months_ahead, work_days: totalWork, off_days: totalOff });
  } catch (e) { console.error('[schedule/batch]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── POST /api/schedule/apply-pattern — застосувати схему графіка (2/2, 3/2, 5/2…) на весь місяць ──
// Body: { master_id, ym:"YYYY-MM", work_days:Int, off_days:Int, anchor:"YYYY-MM-DD" (перший робочий день циклу),
//         start:"09:00", end:"18:00", overwrite_offs:true }
// Генерує робочі дні та вихідні за циклом (work_days підряд, потім off_days вихідних) від дати anchor.
// Всі записи source='manual' (захищені від синхронізації BeautyPro). Ідемпотентно (ON CONFLICT).
// overwrite_offs:false → у дні-вихідні схеми НЕ чіпає наявний графік (тільки виставляє робочі зміни).
router.post('/apply-pattern', async (req, res) => {
  try {
    const pool = getPool();
    let { master_id, ym, work_days, off_days, anchor, start, end, overwrite_offs } = req.body || {};
    if (!master_id || !ym) return res.status(400).json({ error: 'master_id and ym required' });
    if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'ym must be YYYY-MM' });
    work_days = parseInt(work_days, 10); off_days = parseInt(off_days, 10);
    if (!(work_days >= 1) || !(off_days >= 0) || (work_days + off_days) < 1)
      return res.status(400).json({ error: 'work_days/off_days invalid' });
    if (!/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || ''))
      return res.status(400).json({ error: 'start/end must be HH:MM' });
    if (end <= start) return res.status(400).json({ error: 'end must be after start' });
    const [Y, M] = ym.split('-').map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) anchor = `${ym}-01`;
    const cycle = work_days + off_days;
    const anchorD = new Date(anchor + 'T00:00:00Z');
    const dayMs = 86400000;
    const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    let workCount = 0, offCount = 0, skipped = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const cur = new Date(Date.UTC(Y, M - 1, d));
      const iso = cur.toISOString().slice(0, 10);
      let idx = Math.round((cur - anchorD) / dayMs) % cycle;
      if (idx < 0) idx += cycle;
      const isWork = idx < work_days;
      if (isWork) {
        await pool.query(
          `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
             VALUES ($1,$2,$3,$4,'manual',NOW())
           ON CONFLICT (master_id, work_date)
           DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, source='manual', synced_at=NOW()`,
          [master_id, iso, start, end]);
        workCount++;
      } else if (overwrite_offs !== false) {
        await pool.query(
          `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
             VALUES ($1,$2,NULL,NULL,'manual',NOW())
           ON CONFLICT (master_id, work_date)
           DO UPDATE SET start_time=NULL, end_time=NULL, source='manual', synced_at=NOW()`,
          [master_id, iso]);
        offCount++;
      } else { skipped++; }
    }
    res.json({ ok: true, work_days: workCount, off_days: offCount, skipped, days_total: daysInMonth });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/schedule/day?master_id=&date= — прибрати ручний запис, повернути до шаблону ──
router.delete('/day', async (req, res) => {
  try {
    const pool = getPool();
    const { master_id, date } = req.query;
    if (!master_id || !date) return res.status(400).json({ error: 'master_id and date required' });
    await pool.query("DELETE FROM master_schedule_days WHERE master_id=$1 AND work_date=$2 AND source='manual'", [master_id, date]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/schedule/copy-week — копіювати тиждень графіка на інший тиждень ──
// Body: { master_id?, from:"YYYY-MM-DD" (будь-який день тижня-джерела), to:"YYYY-MM-DD" (будь-який день цільового тижня) }
// Копіює явні ручні записи (master_schedule_days) з тижня-джерела у цільовий тиждень (Пн→Нд).
// Без master_id — копіює для всіх майстрів. Перезаписує цільові ручні записи того ж дня.
router.post('/copy-week', async (req, res) => {
  try {
    const pool = getPool();
    const { master_id, from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'dates must be YYYY-MM-DD' });
    }
    // нормалізуємо до понеділка тижня (ISO: Пн=0)
    const monday = (s) => { const d = new Date(s + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d; };
    const srcMon = monday(from), dstMon = monday(to);
    const fmt = (d) => d.toISOString().slice(0, 10);
    if (fmt(srcMon) === fmt(dstMon)) return res.status(400).json({ error: 'Тиждень-джерело і цільовий збігаються' });
    const srcEnd = new Date(srcMon); srcEnd.setUTCDate(srcEnd.getUTCDate() + 6);
    const args = [fmt(srcMon), fmt(srcEnd)];
    let mFilter = '';
    if (master_id) { args.push(parseInt(master_id, 10)); mFilter = `AND master_id = $${args.length}`; }
    const src = await pool.query(
      `SELECT master_id, to_char(work_date,'YYYY-MM-DD') AS work_date, start_time, end_time
         FROM master_schedule_days
        WHERE work_date BETWEEN $1 AND $2 ${mFilter}`, args);
    if (!src.rowCount) return res.json({ ok: true, copied: 0, note: 'У тижні-джерелі немає ручних записів' });
    const dayMs = 86400000;
    let copied = 0;
    for (const row of src.rows) {
      const offset = Math.round((new Date(row.work_date + 'T00:00:00Z') - srcMon) / dayMs);
      const target = new Date(dstMon); target.setUTCDate(target.getUTCDate() + offset);
      await pool.query(
        `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
           VALUES ($1,$2,$3,$4,'manual',NOW())
         ON CONFLICT (master_id, work_date)
         DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, source='manual', synced_at=NOW()`,
        [row.master_id, fmt(target), row.start_time, row.end_time]);
      copied++;
    }
    res.json({ ok: true, copied, from: fmt(srcMon), to: fmt(dstMon) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/schedule/availability?date=2026-06-10 — кто работает в конкретный день ──
router.get('/availability', async (req, res) => {
  try {
    const pool = getPool();
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date).getDay()];

    const masters = await pool.query(
      'SELECT id, name, specialty, avatar, schedule_json FROM masters WHERE active = true AND COALESCE(provides_services, true) = true'
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
        WHERE active = true AND COALESCE(provides_services, true) = true ${masterOnly ? 'AND id = $1' : ''} ORDER BY name`,
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
              a.starts_at, a.ends_at, a.status, a.notes, a.source,
              COALESCE(a.price, s.price) AS price,
              a.real_amount,
              -- Назва послуги: якщо у записі кілька послуг (appointment_services) —
              -- показуємо ВСІ через « + », а не лише першу (інакше «стрижка» замість
              -- реального «холодне відновлення + …»). Якщо мульти-послуг нема — беремо s.name.
              COALESCE(
                (SELECT string_agg(s2.name, ' + ' ORDER BY aps.starts_at, aps.id)
                   FROM appointment_services aps
                   LEFT JOIN services s2 ON s2.id = aps.service_id
                  WHERE aps.appointment_id = a.id AND s2.name IS NOT NULL),
                s.name
              ) AS service_name,
              (SELECT COUNT(*)::int FROM appointment_services aps WHERE aps.appointment_id = a.id) AS services_count,
              (SELECT COALESCE(json_agg(json_build_object(
                        'id', aps.id,
                        'name', s2.name, 'price', aps.price, 'duration', aps.duration_min,
                        'master_id', aps.master_id, 'start', aps.starts_at) ORDER BY aps.starts_at, aps.id), '[]')
                   FROM appointment_services aps
                   LEFT JOIN services s2 ON s2.id = aps.service_id
                  WHERE aps.appointment_id = a.id) AS services_list,
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
              -- Спосіб оплати (cash/card) — той самий матчинг, що й «оплачено».
              COALESCE(
                (SELECT co.method FROM cash_operations co
                   WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id
                   ORDER BY co.id DESC LIMIT 1),
                (SELECT co.method FROM cash_operations co
                   WHERE co.type='in' AND co.ref_type='bp_sale' AND co.category='sale_service'
                     AND a.bp_client IS NOT NULL AND a.master_id IS NOT NULL
                     AND co.bp_client = a.bp_client AND co.master_id = a.master_id
                     AND (COALESCE(co.bp_calendar, co.created_at) AT TIME ZONE 'Europe/Kyiv')::date
                         = (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date
                   ORDER BY co.id DESC LIMIT 1)
              ) AS pay_method,
              COALESCE(
                NULLIF(c.name,''),
                CASE WHEN a.bp_client ~* '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN NULL ELSE a.bp_client END,
                'Клієнт'
              ) AS client_name,
              c.phone AS client_phone,
              -- Побажання клієнта з ОНЛАЙН-ЗАПИСУ (наша таблиця online_bookings, не BeautyPro).
              -- Тримаємо ОКРЕМО від notes (notes = формула/замітка майстра), щоб в картці
              -- було чітко видно: де написав клієнт, а де адмін. Звʼязок по клієнту+даті
              -- (онлайн-бронь завжди привʼязана до конкретного клієнта й дня). Працює і без
              -- BeautyPro — джерело наша БД.
              (SELECT ob.note FROM online_bookings ob
                 WHERE ob.note IS NOT NULL AND btrim(ob.note) <> ''
                   AND ((a.client_id IS NOT NULL AND ob.client_id = a.client_id)
                        OR (c.phone IS NOT NULL AND ob.client_phone = c.phone))
                   AND (ob.date_from AT TIME ZONE 'Europe/Kyiv')::date
                       = (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date
                 ORDER BY ob.created_at DESC LIMIT 1) AS client_wish,
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
          ${masterOnly ? `AND (a.master_id = $2 OR EXISTS(
                SELECT 1 FROM appointment_services aps2
                 WHERE aps2.appointment_id = a.id AND aps2.master_id = $2))` : ''}
        ORDER BY a.starts_at`,
      masterOnly ? [date, masterOnly] : [date]
    );

    // Один візит у BeautyPro може містити послуги РІЗНИХ майстрів (напр. манікюр у
    // Кушнерук + мелірування у Вери в одному записі). Запис цілком висів на майстрі
    // ПЕРШОЇ послуги, тягнучи чужу послугу та її тривалість у його колонку (баг
    // «у нігтьового майстра стоїть мелір на 7 годин»). Розбиваємо такий запис на
    // сегменти ПО МАЙСТРАХ: кожен бачить лише свої послуги, свій час і свою суму.
    // Карта id→імʼя для ВСІХ майстрів (включно з неактивними) — щоб сегмент чужого
    // майстра показував його справжнє імʼя, а не імʼя майстра-власника запису
    // (баг «у колонці Вери стоїть запис, а в картці написано Лера»).
    const mNameById = new Map();
    try {
      const allM = await pool.query('SELECT id, name FROM masters');
      allM.rows.forEach(r => mNameById.set(Number(r.id), r.name));
    } catch (_) { /* fallback на master_name запису нижче */ }
    const splitByMaster = (a) => {
      const list = Array.isArray(a.services_list) ? a.services_list : [];
      if (list.length < 2) return [a];
      const effMid = (s) => (s.master_id != null ? Number(s.master_id) : Number(a.master_id));
      const distinct = [...new Set(list.map(effMid).filter((x) => Number.isFinite(x)))];
      if (distinct.length < 2) return [a]; // всі послуги одного майстра — не чіпаємо
      return distinct.map((mid) => {
        const svcs = list.filter((s) => effMid(s) === mid);
        const startsMs = svcs.map((s) => (s.start ? new Date(s.start).getTime() : NaN)).filter((x) => !Number.isNaN(x));
        const endsMs = svcs.map((s) => (s.start ? new Date(s.start).getTime() + (Number(s.duration) || 0) * 60000 : NaN)).filter((x) => !Number.isNaN(x));
        const segStart = startsMs.length ? new Date(Math.min(...startsMs)) : new Date(a.starts_at);
        let segEnd = endsMs.length ? new Date(Math.max(...endsMs)) : new Date(a.ends_at);
        if (segEnd.getTime() <= segStart.getTime()) segEnd = new Date(segStart.getTime() + 15 * 60000);
        const price = svcs.reduce((acc, s) => acc + (Number(s.price) || 0), 0);
        const sameMaster = Number(mid) === Number(a.master_id);
        return {
          ...a,
          master_id: mid,
          // імʼя майстра сегмента (а не власника запису) — інакше картка чужого
          // сегмента показує не того майстра, в чиїй колонці вона стоїть
          master_name: mNameById.get(Number(mid)) || a.master_name,
          starts_at: segStart.toISOString(),
          ends_at: segEnd.toISOString(),
          price: price || a.price,
          service_name: svcs.map((s) => s.name).filter(Boolean).join(' + ') || a.service_name,
          services_count: svcs.length,
          services_list: svcs,
          duration_min: Math.round((segEnd.getTime() - segStart.getTime()) / 60000),
          // real_amount — це сума, СПЛАЧЕНА за ВЕСЬ візит (усі майстри разом).
          // Не можна тягнути її в кожен сегмент: інакше колонка чужого майстра
          // показує гроші іншого (баг «у Вери 850₴ за нігті Лери»). Скидаємо в null —
          // плитка й підсумок колонки впадуть на price сегмента (лише свої послуги).
          real_amount: null,
          // оплата рахувалась SQL-ом саме для майстра запису; для чужого сегмента
          // не знаємо → краще пропуск, ніж брехливе «оплачено»
          paid: sameMaster ? a.paid : false,
          pay_method: sameMaster ? a.pay_method : null,
          _split: true,
        };
      });
    };
    aRes.rows = aRes.rows.flatMap(splitByMaster);
    // майстер у власному кабінеті бачить лише свої сегменти (не чужі послуги візиту)
    if (masterOnly) aRes.rows = aRes.rows.filter((a) => Number(a.master_id) === Number(masterOnly));

    // Майстер не бачить номери клієнтів (одиночка і салон з увімкненим тумблером — бачать)
    let appts = aRes.rows;
    if (await shouldMaskPhones(req.user)) {
      appts = appts.map(a => ({ ...a, client_phone: maskPhone(a.client_phone), phone_hidden: true }));
    }

    // блокування часу на цей день (CRM-06 06.05)
    let blocks = [];
    try {
      const blkRes = await pool.query(
        `SELECT id, master_id, starts_at, ends_at, reason, block_type
           FROM time_blocks
          WHERE starts_at < ($1::date + INTERVAL '1 day')
            AND ends_at   > $1::date
            ${masterOnly ? 'AND master_id = $2' : ''}
          ORDER BY starts_at`,
        masterOnly ? [date, masterOnly] : [date]
      );
      blocks = blkRes.rows;
    } catch (_) { /* міграція 050 ще не застосована */ }

    res.json({ date, day: dayKey, masters, appointments: appts, blocks, count: appts.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/schedule/online-events?since=<ISO> ────────────────────────────
// Легкий пулінг для журналу: повертає НОВІ онлайн-записи та онлайн-скасування,
// що зʼявилися ПІСЛЯ переданого часу `since`. Адмінка опитує раз на ~15с і дзвонить
// дзвіночком + показує спливаюче вікно. Тільки канали клієнта (bot/site_*),
// admin-записи ігноруємо (їх адмін робить сам — не треба сповіщати). RLS тенанта
// застосовується автоматично через app.tenant_id (бачимо лише свій салон).
router.get('/online-events', async (req, res) => {
  try {
    const pool = getPool();

    // Курсор «нових записів» — по id (SERIAL завжди зростає). Надійніше за час:
    // booking-bridge синкає брони з BeautyPro зі СТАРИМ created_at (час створення
    // у BP, не момент синку), тож детект по часу пропускав би їх. id-курсор ловить
    // будь-який новий рядок незалежно від created_at.
    const sinceId = parseInt(req.query.since_id, 10);
    // Курсор «скасувань» — по часу (скасування = UPDATE, id не змінюється).
    let since = req.query.since;
    if (!since || isNaN(Date.parse(since))) since = new Date().toISOString();
    const floorMs = Date.now() - 6 * 3600 * 1000; // не глибше 6 год (без лавини дзвонів)
    const effSince = new Date(Math.max(Date.parse(since), floorMs)).toISOString();

    // Перший виклик (курсор ще не відомий) — повертаємо лише поточний max(id),
    // без подій. Інакше при відкритті вкладки задзвонило б на всі минулі записи.
    if (!Number.isFinite(sinceId)) {
      const mx = await pool.query(`SELECT COALESCE(MAX(id),0)::int AS max_id FROM online_bookings`);
      return res.json({ server_now: new Date().toISOString(), max_id: mx.rows[0].max_id, events: [] });
    }

    const r = await pool.query(
      `SELECT id, client_name, client_phone, service_name, master_name,
              date_from, channel, status, created_at, updated_at, 'new' AS event_type
         FROM online_bookings
        WHERE id > $1
          AND COALESCE(channel,'') IN ('bot','bot-chat','site_salon','site_shop')
          AND COALESCE(status,'') NOT IN ('cancelled')
      UNION ALL
       SELECT id, client_name, client_phone, service_name, master_name,
              date_from, channel, status, created_at, updated_at, 'cancelled' AS event_type
         FROM online_bookings
        WHERE status = 'cancelled'
          AND COALESCE(channel,'') IN ('bot','bot-chat','site_salon','site_shop')
          AND updated_at > $2::timestamptz
          AND updated_at > created_at + INTERVAL '2 seconds'
        ORDER BY id ASC
        LIMIT 30`,
      [sinceId, effSince]
    );

    const maxId = r.rows.reduce((mx, e) => (e.event_type === 'new' && e.id > mx ? e.id : mx), sinceId);
    let events = r.rows;
    if (await shouldMaskPhones(req.user)) {
      events = events.map(e => ({ ...e, client_phone: maskPhone(e.client_phone), phone_hidden: true }));
    }
    res.json({ server_now: new Date().toISOString(), max_id: maxId, events });
  } catch (e) {
    console.error('[online-events]', e.message);
    // Не валимо пулінг 500-кою — віддаємо порожньо, фронт просто чекає далі.
    res.json({ server_now: new Date().toISOString(), events: [], error: 'soft' });
  }
});

// ── GET /api/schedule/appointments/:id/details — деталі візиту: послуги + товари/розхідники ──
// Повертає реальні товари (salon_product_sales) того ж клієнта того ж дня (київський),
// щоб у картці запису було видно «що продано/витрачено», а не лише послугу.
router.get('/appointments/:id/details', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad-id' });

    const aRes = await pool.query(
      `SELECT a.id, a.master_id, a.client_id, a.bp_client, a.starts_at, a.status,
              COALESCE(a.price, s.price) AS price, a.real_amount,
              s.name AS service_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.id = $1`, [id]
    );
    if (!aRes.rows.length) return res.status(404).json({ error: 'not-found' });
    const a = aRes.rows[0];

    // Майстер бачить деталі лише власного запису
    if (req.user && req.user.role === 'master' && Number(req.user.master_id) !== Number(a.master_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Послуги візиту (якщо є кілька в appointment_services) + сама послуга запису
    let services = [];
    try {
      const sRes = await pool.query(
        `SELECT COALESCE(s.name, 'Послуга') AS name, asv.price
           FROM appointment_services asv
           LEFT JOIN services s ON s.id = asv.service_id
          WHERE asv.appointment_id = $1
          ORDER BY asv.id`, [id]
      );
      services = sRes.rows;
    } catch (_) { /* таблиці може не бути */ }
    if (!services.length && a.service_name) {
      services = [{ name: a.service_name, price: a.price }];
    }

    // Товари/розхідники: продажі того ж клієнта того ж київського дня.
    // DISTINCT ON знімає дублі синхри (та сама позиція з різним ext_ref) —
    // інакше картка показала б подвоєні товари (баг подвоєння BP-sales).
    let products = [];
    if (a.bp_client) {
      const pRes = await pool.query(
        `SELECT DISTINCT ON (product_name, total_price, qty)
                product_name AS name, qty, total_price, master_name
           FROM salon_product_sales
          WHERE bp_client = $1
            AND (sale_date AT TIME ZONE 'Europe/Kyiv')::date
                = (($2::timestamptz) AT TIME ZONE 'Europe/Kyiv')::date
          ORDER BY product_name, total_price, qty, id`, [a.bp_client, a.starts_at]
      );
      products = pRes.rows;
    }
    const products_total = products.reduce((s, p) => s + Number(p.total_price || 0), 0);

    res.json({
      id: a.id, status: a.status, price: a.price, real_amount: a.real_amount,
      services, products, products_total,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/schedule/blocks — заблокувати час майстра (CRM-06 06.05) ──
// Body: { master_id, starts_at, ends_at, reason?, block_type? }
router.post('/blocks', async (req, res) => {
  try {
    const pool = getPool();
    const { master_id, starts_at, ends_at, reason, block_type } = req.body || {};
    if (!master_id || !starts_at || !ends_at) return res.status(400).json({ error: 'master_id, starts_at, ends_at обовʼязкові' });
    const sd = new Date(starts_at), ed = new Date(ends_at);
    if (isNaN(sd) || isNaN(ed)) return res.status(400).json({ error: 'bad-date' });
    if (ed <= sd) return res.status(400).json({ error: 'ends_at має бути пізніше starts_at' });
    const allowed = ['busy', 'break', 'vacation', 'sick', 'other'];
    const type = allowed.includes(block_type) ? block_type : 'busy';
    // майстер може блокувати лише власний час
    if (req.user && req.user.role === 'master' && req.user.master_id && Number(req.user.master_id) !== Number(master_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // дозвіл майстрам займати час керується власником салону (заметка #50, дефолт — заборонено)
    if (req.user && req.user.role === 'master') {
      const allowMasters = await getSetting('masters_can_block_time', false);
      if (!allowMasters) return res.status(403).json({ error: 'Блокування часу вимкнено адміністратором салону' });
    }
    const r = await pool.query(
      `INSERT INTO time_blocks (master_id, starts_at, ends_at, reason, block_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [master_id, sd.toISOString(), ed.toISOString(), reason || null, type, (req.user && req.user.display_name) || null]
    );
    res.json({ ok: true, block: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/schedule/blocks/:id — зняти блокування ──
router.delete('/blocks/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (req.user && req.user.role === 'master' && req.user.master_id) {
      const own = await pool.query(`SELECT 1 FROM time_blocks WHERE id=$1 AND master_id=$2`, [id, req.user.master_id]);
      if (own.rowCount === 0) return res.status(403).json({ error: 'forbidden' });
    }
    await pool.query(`DELETE FROM time_blocks WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/schedule/appointments/:id — заметка / статус ──
router.patch('/appointments/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { notes, status, room_id, starts_at, master_id, duration_min, service_id, price } = req.body || {};
    if (notes === undefined && status === undefined && room_id === undefined
        && starts_at === undefined && master_id === undefined && duration_min === undefined
        && service_id === undefined && price === undefined) {
      return res.status(400).json({ error: 'nothing-to-update' });
    }
    const allowed = ['booked', 'confirmed', 'arrived', 'done', 'cancelled', 'noshow'];
    if (status !== undefined && !allowed.includes(status)) {
      return res.status(400).json({ error: 'bad-status' });
    }
    // Ручна зміна планової суми (заметки #94/#96): пишемо число в нашу БД, вона головна
    if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
      return res.status(400).json({ error: 'bad-price' });
    }

    // Поточний стан запису (тривалість, старт, майстер) — потрібен для переносу/зміни тривалості/перевірки професії
    let curRow = null;
    if (starts_at !== undefined || duration_min !== undefined || master_id !== undefined || service_id !== undefined) {
      const cur = await pool.query(
        `SELECT starts_at, ends_at, EXTRACT(EPOCH FROM (ends_at - starts_at))/60 AS dur, master_id
           FROM appointments WHERE id=$1`,
        [req.params.id]
      );
      if (!cur.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
      curRow = cur.rows[0];
    }

    // #95: запис у минулому дні (або перенос у минулий день) — лише коли увімкнено allow_edit_past
    let _psStart = curRow && curRow.starts_at;
    if (!_psStart) {
      const c95 = await pool.query('SELECT starts_at FROM appointments WHERE id=$1', [req.params.id]);
      if (!c95.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
      _psStart = c95.rows[0].starts_at;
    }
    if (await pastEditDenied(req, _psStart) || (starts_at !== undefined && await pastEditDenied(req, starts_at))) {
      return res.status(403).json(PAST_LOCKED);
    }

    // Зміна послуги → підтягуємо планову ціну й тривалість нової послуги.
    // Фактичну оплату (поле price тут = планова сума запису) оновлюємо на ціну послуги.
    let svcRow = null;
    if (service_id !== undefined && service_id != null) {
      const sv = await pool.query('SELECT price, duration_min, name FROM services WHERE id=$1', [Number(service_id)]);
      if (!sv.rows[0]) return res.status(400).json({ error: 'service-not-found' });
      svcRow = sv.rows[0];
    }

    // Перенос лише на майстра тієї самої професії (заметка #30)
    if (master_id !== undefined && master_id != null && Number(master_id) !== Number(curRow.master_id)) {
      const prof = await pool.query(
        `SELECT a.specialty AS cur_spec, b.specialty AS new_spec
           FROM masters a, masters b WHERE a.id=$1 AND b.id=$2`,
        [curRow.master_id, Number(master_id)]
      );
      if (prof.rows[0]) {
        const cs = (prof.rows[0].cur_spec || '').trim().toLowerCase();
        const ns = (prof.rows[0].new_spec || '').trim().toLowerCase();
        if (cs && ns && cs !== ns) {
          return res.status(409).json({ error: 'different-profession', message: 'Перенесення можливе лише на майстра тієї самої професії' });
        }
      }
    }

    // Перенос (нове starts_at), зміна тривалості (duration_min) або зміна послуги → перераховуємо ends_at.
    // Пріоритет тривалості: явний duration_min → тривалість нової послуги → поточна тривалість запису.
    let newStart = null, newEnd = null;
    if (starts_at !== undefined || duration_min !== undefined || service_id !== undefined) {
      const baseStart = starts_at !== undefined ? new Date(starts_at) : new Date(curRow.starts_at);
      if (isNaN(baseStart)) return res.status(400).json({ error: 'bad-starts_at' });
      let dur = duration_min !== undefined ? Number(duration_min)
              : (svcRow && Number(svcRow.duration_min) > 0 ? Number(svcRow.duration_min)
              : (Number(curRow.dur) || 30));
      if (!Number.isFinite(dur) || dur <= 0) return res.status(400).json({ error: 'bad-duration_min' });
      dur = Math.min(dur, 24 * 60); // запобіжник
      if (starts_at !== undefined) newStart = baseStart.toISOString();
      newEnd = new Date(baseStart.getTime() + dur * 60000).toISOString();
    }

    // Планова сума запису: явна ручна ціна (заметки #94/#96) має пріоритет над ціною нової послуги.
    // Фактичні оплати в продажах не чіпаємо.
    const newPrice = price !== undefined ? Number(price) : (svcRow ? Number(svcRow.price) : null);

    // защита от двойного бронирования при переносе времени/смене мастера
    if (newStart || newEnd || master_id != null) {
      const effMaster = master_id != null ? Number(master_id) : curRow.master_id;
      const effStart = newStart || curRow.starts_at;
      const effEnd = newEnd || curRow.ends_at;
      const conflict = await findOverlap({ masterId: effMaster, startsAt: effStart, endsAt: effEnd, excludeId: Number(req.params.id) });
      if (conflict) {
        return res.status(409).json({ error: 'slot-busy', conflict_id: conflict.id,
          message: 'У майстра вже є запис на цей час' });
      }
    }

    // Ручний перенос (час/майстер/тривалість/послуга/сума) → позначаємо manual_override,
    // щоб автосинхронізація BeautyPro не перетирала ці поля назад кожні 5 хв.
    const markManual = (starts_at !== undefined || master_id !== undefined || duration_min !== undefined || service_id !== undefined || price !== undefined);
    const r = await pool.query(
      `UPDATE appointments
          SET notes = COALESCE($2, notes),
              status = COALESCE($3, status),
              room_id = COALESCE($4, room_id),
              master_id = COALESCE($5, master_id),
              starts_at = COALESCE($6, starts_at),
              ends_at = COALESCE($7, ends_at),
              service_id = COALESCE($9, service_id),
              price = COALESCE($10, price),
              manual_override = CASE WHEN $8 THEN true ELSE manual_override END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, notes, status, room_id, master_id, starts_at, ends_at, service_id, price, real_amount`,
      [req.params.id, notes ?? null, status ?? null, room_id ?? null,
       master_id != null ? Number(master_id) : null, newStart, newEnd, markManual,
       service_id != null ? Number(service_id) : null, newPrice]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });

    // Зміна ціни ВЖЕ оплаченого запису → синхронізуємо суму приходу в касі (заметка #114).
    // Сума в касі = ціна послуги + платні матеріали (фарба за грам). Продажі BP не чіпаємо.
    if (newPrice != null && Number.isFinite(newPrice) && newPrice > 0) {
      await pool.query(
        `UPDATE cash_operations co SET amount = $2 + COALESCE((
            SELECT SUM(CASE WHEN p.price_per_gram IS NOT NULL THEN ROUND(am.qty_used * p.price_per_gram, 2)
                            WHEN am.billable IS TRUE       THEN ROUND(am.qty_used * COALESCE(pv.price,0), 2)
                            ELSE 0 END)
              FROM appointment_materials am
              JOIN product_variants pv ON pv.id = am.variant_id
              JOIN products p ON p.id = pv.product_id
             WHERE am.appointment_id = $1), 0)
          WHERE co.ref_type='appointment' AND co.ref_id=$1 AND co.type='in' AND co.category='sale_service'`,
        [Number(req.params.id), newPrice]
      ).catch(e => console.error('[schedule] price→cash sync:', e.message));
    }

    // услуга выполнена → списываем расходники со склада (идемпотентно)
    let stock = null;
    if (status === 'done') {
      try {
        const { writeOffForAppointment } = require('../lib/consumables');
        stock = await writeOffForAppointment(Number(req.params.id));
      } catch (e) { stock = { written: false, error: e.message }; }
      await emitAppointmentCompleted(req.params.id, r.rows[0] && r.rows[0].master_id);
    } else if (status !== undefined && status !== 'done') {
      // відкат «Виконано» → повертаємо списані матеріали на склад (ідемпотентно, всередині перевіряється флаг)
      try {
        const { reverseWriteOffForAppointment } = require('../lib/consumables');
        const rev = await reverseWriteOffForAppointment(Number(req.params.id));
        if (rev && rev.reversed) stock = rev;
      } catch (e) { /* best-effort: не блокуємо зміну статусу */ }
      if (status === 'confirmed' || status === 'noshow') {
        // в журнал событий + вебхуки. noshow → база для авто-тега/переслота (подписчик — отдельно)
        await emitAppt('appointment.' + status, req.params.id, r.rows[0] && r.rows[0].master_id);
      }
    }
    res.json({ ok: true, appointment: r.rows[0], stock });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/schedule/appointments/:id/services — додати послугу до складу візиту (заметка #90) ──
// Дозволяє «доукомплектувати» вже створений запис ще однією послугою: сума й час перераховуються.
// Якщо у записі ще немає рядків appointment_services — спершу переносимо базову послугу запису
// у склад (щоб перелік візиту був повним), потім додаємо нову.
router.post('/appointments/:id/services', async (req, res) => {
  try {
    const pool = getPool();
    const apptId = Number(req.params.id);
    const { service_id } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'service_id обовʼязковий' });

    const aRes = await pool.query(
      `SELECT id, master_id, service_id, starts_at, ends_at, price,
              EXTRACT(EPOCH FROM (ends_at - starts_at))/60 AS dur
         FROM appointments WHERE id=$1`, [apptId]);
    if (!aRes.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    const a = aRes.rows[0];
    // майстер може правити лише власний запис
    if (req.user && req.user.role === 'master' && Number(req.user.master_id) !== Number(a.master_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // #95: склад візиту минулого дня — лише коли увімкнено allow_edit_past
    if (await pastEditDenied(req, a.starts_at)) return res.status(403).json(PAST_LOCKED);

    const sv = await pool.query('SELECT price, duration_min, name FROM services WHERE id=$1', [Number(service_id)]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'service-not-found' });
    const newDur = Number(sv.rows[0].duration_min) > 0 ? Number(sv.rows[0].duration_min) : 30;
    const newPrice = Number(sv.rows[0].price) || 0;

    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM appointment_services WHERE appointment_id=$1', [apptId]);
    // Якщо складу ще нема — заносимо базову послугу запису першим рядком (щоб перелік був повним)
    if (cnt.rows[0].n === 0 && a.service_id) {
      await pool.query(
        `INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [apptId, a.service_id, a.master_id, a.starts_at, Math.round(Number(a.dur) || 30), Number(a.price) || 0]);
    }
    // Нова послуга стартує після завершення поточного складу
    await pool.query(
      `INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [apptId, Number(service_id), a.master_id, a.ends_at, newDur, newPrice]);

    // Перерахунок підсумків запису зі складу
    const sum = await pool.query(
      `SELECT COALESCE(SUM(price),0) AS total_price, COALESCE(SUM(duration_min),0) AS total_dur
         FROM appointment_services WHERE appointment_id=$1`, [apptId]);
    const totalPrice = Number(sum.rows[0].total_price) || 0;
    const totalDur = Math.min(Number(sum.rows[0].total_dur) || 0, 24 * 60) || (Number(a.dur) || 30);
    const newEnd = new Date(new Date(a.starts_at).getTime() + totalDur * 60000).toISOString();
    const upd = await pool.query(
      `UPDATE appointments SET price=$2, ends_at=$3, manual_override=true, updated_at=NOW()
        WHERE id=$1 RETURNING id, price, starts_at, ends_at`, [apptId, totalPrice, newEnd]);
    res.json({ ok: true, appointment: upd.rows[0], added: sv.rows[0].name });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/schedule/appointments/:id/services/:rowId — прибрати послугу зі складу візиту ──
router.delete('/appointments/:id/services/:rowId', async (req, res) => {
  try {
    const pool = getPool();
    const apptId = Number(req.params.id);
    const rowId = Number(req.params.rowId);
    const aRes = await pool.query('SELECT master_id, starts_at, price, EXTRACT(EPOCH FROM (ends_at - starts_at))/60 AS dur FROM appointments WHERE id=$1', [apptId]);
    if (!aRes.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    if (req.user && req.user.role === 'master' && Number(req.user.master_id) !== Number(aRes.rows[0].master_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // #95: склад візиту минулого дня — лише коли увімкнено allow_edit_past
    if (await pastEditDenied(req, aRes.rows[0].starts_at)) return res.status(403).json(PAST_LOCKED);
    const del = await pool.query('DELETE FROM appointment_services WHERE id=$1 AND appointment_id=$2 RETURNING id', [rowId, apptId]);
    if (!del.rows[0]) return res.status(404).json({ error: 'row-not-found' });
    // Перерахунок підсумків (якщо склад спорожнів — лишаємо суму/час як є)
    const sum = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(price),0) AS total_price, COALESCE(SUM(duration_min),0) AS total_dur
         FROM appointment_services WHERE appointment_id=$1`, [apptId]);
    if (sum.rows[0].n > 0) {
      const totalDur = Math.min(Number(sum.rows[0].total_dur) || 0, 24 * 60) || (Number(aRes.rows[0].dur) || 30);
      const newEnd = new Date(new Date(aRes.rows[0].starts_at).getTime() + totalDur * 60000).toISOString();
      await pool.query('UPDATE appointments SET price=$2, ends_at=$3, manual_override=true, updated_at=NOW() WHERE id=$1',
        [apptId, Number(sum.rows[0].total_price) || 0, newEnd]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/schedule/appointments/:id/services/:rowId — змінити ціну послуги у складі візиту (заметки #94/#96) ──
// Ціна пишеться в нашу БД (вона головна), планова сума запису перераховується,
// manual_override=true — щоб синхронізація BeautyPro не перетерла правку.
router.patch('/appointments/:id/services/:rowId', async (req, res) => {
  try {
    const pool = getPool();
    const apptId = Number(req.params.id);
    const rowId = Number(req.params.rowId);
    const { price } = req.body || {};
    const p = Number(price);
    if (price === undefined || !Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'bad-price' });
    const aRes = await pool.query('SELECT master_id FROM appointments WHERE id=$1', [apptId]);
    if (!aRes.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    // майстер може правити лише власний запис
    if (req.user && req.user.role === 'master' && Number(req.user.master_id) !== Number(aRes.rows[0].master_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const upd = await pool.query('UPDATE appointment_services SET price=$3 WHERE id=$2 AND appointment_id=$1 RETURNING id',
      [apptId, rowId, p]);
    if (!upd.rows[0]) return res.status(404).json({ error: 'row-not-found' });
    // Перерахунок планової суми запису зі складу візиту
    const sum = await pool.query('SELECT COALESCE(SUM(price),0) AS total_price FROM appointment_services WHERE appointment_id=$1', [apptId]);
    const r2 = await pool.query('UPDATE appointments SET price=$2, manual_override=true, updated_at=NOW() WHERE id=$1 RETURNING id, price',
      [apptId, Number(sum.rows[0].total_price) || 0]);
    res.json({ ok: true, appointment: r2.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
    // #95: створення записів заднім числом — лише коли увімкнено allow_edit_past
    if (await pastEditDenied(req, startDate)) return res.status(403).json(PAST_LOCKED);
    const endDate = ends_at ? new Date(ends_at) : new Date(startDate.getTime() + dur * 60000);
    if (isNaN(endDate) || endDate <= startDate) {
      return res.status(400).json({ error: 'ends_at має бути пізніше starts_at' });
    }

    // защита от двойного бронирования: слот мастера не должен пересекаться
    const conflict = await findOverlap({ masterId: Number(master_id), startsAt: startDate, endsAt: endDate });
    if (conflict) {
      return res.status(409).json({ error: 'slot-busy', conflict_id: conflict.id,
        message: 'У майстра вже є запис на цей час' });
    }

    // клієнт: за id, або за телефоном (знайти/створити), або тільки імʼя
    let cid = client_id ? Number(client_id) : null;
    if (!cid && client_phone) {
      // канон БД = '380XXXXXXXXX' (lib/phone.js) — сырой replace создавал дубли
      // клиентов для '0XX...' / '+380...' вводов (регресс аудита #31)
      const canon = normalizePhoneDb(client_phone);
      if (canon) {
        const ex = await pool.query('SELECT id FROM clients WHERE phone=$1', [canon]);
        if (ex.rows[0]) cid = ex.rows[0].id;
        else {
          const nc = await pool.query(
            `INSERT INTO clients (phone, name, source) VALUES ($1,$2,'salon')
             ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
             RETURNING id`,
            [canon, client_name || null]
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
    await emitAppt('appointment.created', r.rows[0].id, Number(master_id)); // в журнал событий + вебхуки
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/schedule/appointments/:id/pay-options — дані для екрана оплати ──
// Баланс бонусів клієнта + налаштування списання (макс %, курс, мінімум).
router.get('/appointments/:id/pay-options', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    const a = await pool.query(`SELECT client_id FROM appointments WHERE id=$1`, [id]);
    if (!a.rows[0]) return res.status(404).json({ error: 'not-found' });
    const bonusLib = require('../lib/bonus');
    let balance = 0, settings = {};
    try { if (a.rows[0].client_id) balance = Number((await bonusLib.getBalance(a.rows[0].client_id)).balance) || 0; } catch (_) {}
    try { const s = await bonusLib.getSettings(); settings = { enabled: s.enabled !== false, max_pay_percent: Number(s.max_pay_percent) || 30, min_redeem: Number(s.min_redeem_amount) || 0, rate: Number(s.exchange_rate) || 1 }; } catch (_) {}
    res.json({ ok: true, client_id: a.rows[0].client_id, bonus_balance: balance, bonus: settings });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

// ── POST /api/schedule/appointments/:id/unpay — скасувати оплату (заметка #114) ──
// Прибирає прихід із каси по цьому запису, повертає статус «підтверджено» і
// списані матеріали на склад. Після цього оплату можна провести заново (іншим
// способом/з іншою ціною) — унікальний індекс знову вільний.
router.post('/appointments/:id/unpay', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const bonusLib = require('../lib/bonus');
    const client = await pool.connect();
    let removed, appt;
    try {
      await client.query('BEGIN'); await applyTenant(client);
      // застосовані знижки/бонуси/сертифікат — для точного відкату
      const a = await client.query(
        `SELECT client_id, pay_cert_code, pay_cert_amount, pay_bonus_redeemed, pay_bonus_accrued, pay_settled_at
           FROM appointments WHERE id=$1 FOR UPDATE`, [id]);
      appt = a.rows[0] || {};
      removed = await client.query(
        `DELETE FROM cash_operations
          WHERE ref_type='appointment' AND ref_id=$1 AND type='in'
          RETURNING id, amount, method`, [id]);
      // сертифікат назад: повертаємо суму + журнал refund
      if (appt.pay_cert_code && Number(appt.pay_cert_amount) > 0) {
        const gc = await client.query(
          `UPDATE gift_certificates SET remaining_amount = remaining_amount + $2,
                  status = CASE WHEN status='fully_used' THEN 'partially_used' ELSE status END, updated_at=NOW()
            WHERE UPPER(code)=UPPER($1) RETURNING id, remaining_amount`, [appt.pay_cert_code, appt.pay_cert_amount]);
        if (gc.rows[0]) await client.query(
          `INSERT INTO gift_certificate_transactions (gc_id,type,amount,balance_after,appointment_id,notes)
           VALUES ($1,'refund',$2,$3,$4,$5)`,
          [gc.rows[0].id, appt.pay_cert_amount, gc.rows[0].remaining_amount, id, `Скасування оплати візиту #${id}`]);
      }
      await client.query(
        `UPDATE appointments SET status='confirmed', updated_at=NOW(),
                discount_amount=NULL, pay_cert_code=NULL, pay_cert_amount=NULL,
                pay_bonus_redeemed=NULL, pay_bonus_money=NULL, pay_bonus_accrued=NULL, pay_settled_at=NULL
          WHERE id=$1`, [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    if (!removed.rows[0] && !appt.pay_settled_at) return res.json({ ok: true, nothing_to_cancel: true });
    // бонуси: повертаємо списані, знімаємо нараховані (поза транзакцією — власні tx у lib/bonus)
    if (appt.client_id) {
      if (Number(appt.pay_bonus_redeemed) > 0) await bonusLib.manualAdjust({ clientId: appt.client_id, amount: Number(appt.pay_bonus_redeemed), description: `Повернення бонусів: скасування оплати візиту #${id}` }).catch(() => {});
      if (Number(appt.pay_bonus_accrued) > 0) await bonusLib.manualAdjust({ clientId: appt.client_id, amount: -Number(appt.pay_bonus_accrued), description: `Зняття нарахування: скасування оплати візиту #${id}` }).catch(() => {});
    }
    // повертаємо матеріали на склад (best-effort, ідемпотентно)
    let stock = null;
    try {
      const { reverseWriteOffForAppointment } = require('../lib/consumables');
      stock = await reverseWriteOffForAppointment(id);
    } catch (_) {}
    res.json({ ok: true, cancelled: removed.rows.map(r => ({ id: r.id, amount: Number(r.amount), method: r.method })), reverted_cert: appt.pay_cert_amount || 0, reverted_bonus: appt.pay_bonus_redeemed || 0, stock });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
    // матеріали, що продаються клієнту, додаються до чека:
    //  - фарба за грам (price_per_gram) → грами × ціна/г, продається завжди
    //  - пляшка/шт з прапорцем billable → кількість × роздрібна ціна варіанта
    const mat = await pool.query(
      `SELECT COALESCE(SUM(
                CASE WHEN p.price_per_gram IS NOT NULL THEN ROUND(am.qty_used * p.price_per_gram, 2)
                     WHEN am.billable IS TRUE       THEN ROUND(am.qty_used * COALESCE(pv.price,0), 2)
                     ELSE 0 END),0)::float AS total
         FROM appointment_materials am
         JOIN product_variants pv ON pv.id = am.variant_id
         JOIN products p ON p.id = pv.product_id
        WHERE am.appointment_id = $1`, [id]).catch(() => ({ rows: [{ total: 0 }] }));
    const matTotal = Number(mat.rows[0].total) || 0;
    const base = (Number(appt.price) || 0) + matTotal;   // повна вартість візиту до знижок
    if (base <= 0) return res.status(400).json({ error: 'no-price', message: 'У запису не вказана ціна послуги' });

    // вже оплачено? (ідемпотентність): каса АБО маркер pay_settled_at (для випадку 0 готівки — все закрито сертифікатом/бонусами)
    const dup = await pool.query(
      `SELECT (SELECT id FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in' LIMIT 1) AS op_id,
              (SELECT pay_settled_at FROM appointments WHERE id=$1) AS settled`, [id]
    );
    if (dup.rows[0].op_id || dup.rows[0].settled) {
      await pool.query(`UPDATE appointments SET status='done', updated_at=NOW() WHERE id=$1 AND status<>'done'`, [id]);
      await emitAppointmentCompleted(id, appt.master_id);
      return res.json({ ok: true, already_paid: true, operation_id: dup.rows[0].op_id || null });
    }

    // ── ЗНИЖКИ: ручна знижка → сертифікат → бонуси. Каса отримує РЕШТУ (реальні гроші). ──
    const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const bonusLib = require('../lib/bonus');
    const dType = req.body?.discount_type;         // 'percent' | 'fixed'
    const dVal = Number(req.body?.discount_value) || 0;
    const certCode = String(req.body?.certificate_code || '').trim().toUpperCase();
    const bonusReq = Number(req.body?.bonus_amount) || 0;

    let remaining = base;
    // 1) ручна знижка
    let discountMoney = 0;
    if (dType === 'percent' && dVal > 0) discountMoney = round2(base * Math.min(dVal, 100) / 100);
    else if (dType === 'fixed' && dVal > 0) discountMoney = Math.min(round2(dVal), base);
    remaining = round2(remaining - discountMoney);

    // 2) сертифікат (валідуємо зараз, списуємо в транзакції)
    let certRow = null, certMoney = 0;
    if (certCode && remaining > 0) {
      const gc = await pool.query(
        `SELECT id, code, remaining_amount, status, valid_until FROM gift_certificates WHERE UPPER(code)=$1`, [certCode]);
      if (!gc.rows[0]) return res.status(400).json({ error: 'cert-not-found', message: 'Сертифікат не знайдено' });
      certRow = gc.rows[0];
      if (!['active', 'partially_used', 'issued', 'sold'].includes(certRow.status))
        return res.status(400).json({ error: 'cert-not-usable', message: `Сертифікат недоступний (${certRow.status})` });
      if (certRow.valid_until && String(certRow.valid_until).slice(0, 10) < new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date()))
        return res.status(400).json({ error: 'cert-expired', message: 'Термін дії сертифіката минув' });
      certMoney = Math.min(round2(certRow.remaining_amount), remaining);
      remaining = round2(remaining - certMoney);
    }

    // 3) бонуси (redeem керує власною транзакцією — робимо ДО каси; при dup-гонці нижче повертаємо)
    let bonusMoney = 0, bonusRedeemed = 0;
    if (bonusReq > 0 && appt.client_id && remaining > 0) {
      try {
        const r = await bonusLib.redeem({ clientId: appt.client_id, amount: bonusReq, checkAmount: remaining,
          sourceType: 'appointment-pay', sourceId: id, description: `Оплата візиту #${id}` });
        bonusMoney = round2(r.money); bonusRedeemed = round2(r.redeemed);
        remaining = round2(remaining - bonusMoney);
      } catch (e) {
        return res.status(400).json({ error: 'bonus-redeem-failed', message: 'Не вдалося списати бонуси: ' + e.message });
      }
    }
    const finalCash = Math.max(0, round2(remaining));
    const totalDiscount = round2(discountMoney + certMoney + bonusMoney);
    // сумісність зі старим кодом нижче: amount = скільки реально в касу
    const amount = finalCash;
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
        await emitAppointmentCompleted(id, appt.master_id);
        return res.json({ ok: true, already_paid: true, paid_via: 'beautypro', operation_id: bp.rows[0].id });
      }
    }

    // відкрита зміна каси (обовʼязкова лише при require_open_shift='true' — заметка #103)
    const sh = await pool.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
    const requireShift = String(await getSetting('require_open_shift', false)) === 'true';
    if (!sh.rows[0] && requireShift) return res.status(400).json({ error: 'no-open-shift', message: 'Немає відкритої зміни каси. Відкрийте зміну в розділі «Каса».' });
    let shiftId = sh.rows[0]?.id || null;

    // Ретро-оплата (заметка #112): якщо візит був у МИНУЛИЙ день, а «Виконано» натиснули
    // сьогодні — гроші датуємо днем візиту, інакше вони хибно потрапляють у «Касу за день»
    // сьогодні. До поточної зміни таку операцію теж не чіпляємо (щоб не псувати підсумок зміни).
    const _kyivDay = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(ts));
    const isRetro = appt.starts_at && _kyivDay(appt.starts_at) < _kyivDay(Date.now());
    const opCreatedAt = isRetro ? appt.starts_at : null; // null → NOW() за замовчуванням
    if (isRetro) shiftId = null;

    // Приход в кассу + статус «выполнено» — АТОМАРНО в одной транзакции.
    // Иначе при падении между ними возможен рассинхрон (деньги есть, статус нет — или наоборот).
    // Гонка двух параллельных /pay: SELECT-then-INSERT выше дырявый, поэтому дубль
    // добивает partial UNIQUE ux_cash_ops_appt_payment (миграция 198) + ON CONFLICT
    // DO NOTHING — проигравший запрос получает идемпотентный 200 already_paid, не вторую оплату.
    const descr = (appt.service_name || 'Послуга')
      + (matTotal > 0 ? ` + матеріали ${matTotal} грн` : '')
      + (totalDiscount > 0 ? ` (знижка ${totalDiscount} грн)` : '');
    const client = await pool.connect();
    let op = { rows: [{ id: null }] }, raceLost = false;
    try {
      await client.query('BEGIN'); await applyTenant(client);
      // каса отримує реальні гроші лише якщо finalCash > 0 (0 → все закрито сертифікатом/бонусами)
      if (finalCash > 0) {
        op = await client.query(
          `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, created_at)
           VALUES ($1,'in','sale_service',$2,$3,'appointment',$4,$5,$6,COALESCE($7,NOW()))
           ON CONFLICT (tenant_id, ref_type, ref_id) WHERE type='in' AND ref_type='appointment' DO NOTHING
           RETURNING id`,
          [shiftId, finalCash, method, id, appt.master_id || null, descr, opCreatedAt]
        );
        if (!op.rows[0]) raceLost = true;
      }
      if (!raceLost) {
        // списання сертифіката (атомарно з касою)
        if (certRow && certMoney > 0) {
          await client.query(
            `UPDATE gift_certificates
                SET remaining_amount = remaining_amount - $2,
                    status = CASE WHEN remaining_amount - $2 <= 0.001 THEN 'fully_used' ELSE 'partially_used' END,
                    updated_at = NOW()
              WHERE id = $1`, [certRow.id, certMoney]);
          await client.query(
            `INSERT INTO gift_certificate_transactions (gc_id, type, amount, balance_after, appointment_id, notes)
             VALUES ($1,'usage',$2,$3,$4,$5)`,
            [certRow.id, certMoney, round2(Number(certRow.remaining_amount) - certMoney), id, `Оплата візиту #${id}`]);
        }
        await client.query(
          `UPDATE appointments SET status='done', updated_at=NOW(),
                  discount_amount=$2, pay_cert_code=$3, pay_cert_amount=$4,
                  pay_bonus_redeemed=$5, pay_bonus_money=$6, pay_settled_at=NOW()
            WHERE id=$1`,
          [id, discountMoney || null, certMoney > 0 ? certRow.code : null, certMoney || null,
           bonusRedeemed || null, bonusMoney || null]);
      }
      await client.query(raceLost ? 'ROLLBACK' : 'COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // повертаємо вже списані бонуси (redeem був до транзакції)
      if (bonusRedeemed > 0) await bonusLib.manualAdjust({ clientId: appt.client_id, amount: bonusRedeemed, description: `Відкат: помилка оплати візиту #${id}` }).catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (raceLost) {
      // проиграли гонку: оплату уже провёл параллельный запрос — повертаємо бонуси, відповідаємо як dup
      if (bonusRedeemed > 0) await bonusLib.manualAdjust({ clientId: appt.client_id, amount: bonusRedeemed, description: `Відкат гонки оплати візиту #${id}` }).catch(() => {});
      const race = await pool.query(`SELECT id FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in' LIMIT 1`, [id]);
      await emitAppointmentCompleted(id, appt.master_id);
      return res.json({ ok: true, already_paid: true, operation_id: race.rows[0]?.id || null });
    }

    // После COMMIT: списание расходников + начисление бонусов от реально оплаченной суммы + эмит — best-effort.
    let stock = null;
    try {
      const { writeOffForAppointment } = require('../lib/consumables');
      stock = await writeOffForAppointment(id);
    } catch (e) { stock = { written: false, error: e.message }; }
    // нарахування бонусів за візит (від суми, сплаченої грошима; ідемпотентно по source)
    let accrued = 0;
    if (appt.client_id && finalCash > 0) {
      try {
        const acc = await bonusLib.accrue({ clientId: appt.client_id, checkAmount: finalCash, autoRule: 'payment',
          sourceType: 'appointment', sourceId: id, description: `Візит #${id}` });
        accrued = acc ? Number(acc.amount || 0) : 0;
        if (accrued > 0) await pool.query(`UPDATE appointments SET pay_bonus_accrued=$2 WHERE id=$1`, [id, accrued]).catch(() => {});
      } catch (_) {}
    }
    await emitAppointmentCompleted(id, appt.master_id);

    res.json({ ok: true, operation_id: op.rows[0].id, base, final: finalCash, method, stock,
      discount: { manual: discountMoney, certificate: certMoney, bonus: bonusMoney, total: totalDiscount }, bonus_accrued: accrued });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── DELETE /api/schedule/appointments/:id — видалити запис ──
// Прибирає касові операції цього запису у ВІДКРИТІЙ зміні, потім видаляє сам запис.
router.delete('/appointments/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const chk = await pool.query(`SELECT id, beautypro_id, starts_at FROM appointments WHERE id=$1`, [id]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });
    // #95: видалення записів минулих днів — лише коли увімкнено allow_edit_past
    if (await pastEditDenied(req, chk.rows[0].starts_at)) return res.status(403).json(PAST_LOCKED);
    // Возврат кассы + удаление/отмена записи — АТОМАРНО. Иначе при падении между ними
    // деньги вернулись, а запись осталась (или наоборот) → рассинхрон кассы.
    const soft = !!chk.rows[0].beautypro_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await applyTenant(client);
      // прибрати привʼязані касові операції лише з відкритих змін (минулі не чіпаємо)
      await client.query(
        `DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1
           AND shift_id IN (SELECT id FROM cash_shifts WHERE status='open')`, [id]
      );
      // Оплати із ЗАКРИТИХ змін і безсменні (shift_id NULL, онлайн) НЕ видаляємо —
      // історію каси не переписуємо. Сторнуємо компенсуючою операцією type='out'.
      // Ідемпотентно: ext_ref 'appt:<id>:storno:<op_id>' + ux_cash_operations_ext_ref,
      // повторний DELETE (soft-cancel BP-запису) не задвоїть сторно.
      await client.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, ext_ref)
         SELECT NULL, 'out', 'refund', co.amount, co.method, 'appointment', co.ref_id, co.master_id,
                'Сторно оплати: видалення запису #' || co.ref_id, 'appt:' || co.ref_id || ':storno:' || co.id
           FROM cash_operations co
          WHERE co.ref_type='appointment' AND co.ref_id=$1 AND co.type='in'
         ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING`, [id]
      );
      // BeautyPro-запис не можна видаляти жорстко: автосинк побачить його в BP і
      // відтворить знову. Тому мʼяке видалення: cancelled + manual_override.
      if (soft) {
        await client.query(
          `UPDATE appointments SET status='cancelled', manual_override=true, updated_at=NOW() WHERE id=$1`, [id]
        );
      } else {
        await client.query(`DELETE FROM appointments WHERE id=$1`, [id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Відкат бонусів, якщо за цю запис нараховували (source_type='appointment',
    // source_id — див. lib/bonus.js + міграція 198). Best-effort після COMMIT:
    // збій відкату не блокує видалення, ідемпотентно по source 'appointment_delete'.
    try {
      const acc = await pool.query(
        `SELECT client_id, SUM(amount)::numeric AS amt FROM bonus_transactions
          WHERE type='accrual' AND source_type='appointment' AND source_id=$1
          GROUP BY client_id`, [id]);
      for (const a of acc.rows) {
        const done = await pool.query(
          `SELECT 1 FROM bonus_transactions
            WHERE type='manual_deduct' AND source_type='appointment_delete' AND source_id=$1 AND client_id=$2 LIMIT 1`,
          [id, a.client_id]);
        if (done.rows[0]) continue;
        await require('../lib/bonus').manualAdjust({
          clientId: a.client_id, amount: -Number(a.amt),
          sourceType: 'appointment_delete', sourceId: id,
          description: `Сторно бонусів: видалення запису #${id}`,
        }).catch(e => console.error('[schedule] bonus storno:', e.message));
      }
    } catch (e) { console.error('[schedule] bonus storno lookup:', e.message); }
    await emitAppt('appointment.cancelled', id, null); // в журнал событий + вебхуки
    res.json({ ok: true, deleted: id, soft });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
