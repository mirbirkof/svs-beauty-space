/* schedule-month.js — єдине джерело правди для місячної сітки графіків.
   Використовується і у GET /api/schedule/month (візуальна сітка), і у
   GET /api/reports/monthly-plan (кількість змін для плану обороту).
   Раніше ці два місця рахували зміни по-різному: сітка розгортала тижневий
   шаблон (18 днів), а план рахував сирі рядки master_schedule_days (11) →
   розбіжність. Тепер обидва викликають buildMonthGrid → числа завжди збігаються. */

const DAYK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Повертає { ym, daysInMonth, dates:[...], items:[{ id,name,specialty,avatar, days:[{date,off,start,end,source}] }] }
async function buildMonthGrid(pool, ym) {
  ym = /^\d{4}-\d{2}$/.test(ym || '') ? ym : new Date().toISOString().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const daysInMonth = new Date(Y, M, 0).getDate();
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth).padStart(2, '0')}`;
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push(`${ym}-${String(d).padStart(2, '0')}`);

  const mrows = (await pool.query(
    `SELECT id, name, specialty, avatar, schedule_json FROM masters
      WHERE active = true AND COALESCE(provides_services, true) = true ORDER BY name`
  )).rows;

  // Явні per-day записи цього місяця (найвищий пріоритет: ручні + з BeautyPro)
  const expl = await pool.query(
    `SELECT master_id, to_char(work_date,'YYYY-MM-DD') AS d,
            to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end,
            source, (start_time IS NULL) AS off
       FROM master_schedule_days
      WHERE work_date BETWEEN $1 AND $2`, [first, last]);
  const explMap = new Map();
  for (const row of expl.rows) {
    if (!explMap.has(row.master_id)) explMap.set(row.master_id, {});
    explMap.get(row.master_id)[row.d] = { start: row.start, end: row.end, off: row.off, source: row.source };
  }

  // Тижневий шаблон: beautypro agg (найчастіший слот per день тижня) > template > auto(записи)
  const bp = await pool.query(
    `SELECT master_id, EXTRACT(DOW FROM work_date)::int AS dow,
            to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
       FROM master_schedule_days
      WHERE work_date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE + 35 AND start_time IS NOT NULL`);
  const agg = new Map();
  for (const row of bp.rows) {
    if (!agg.has(row.master_id)) agg.set(row.master_id, {});
    const wd = agg.get(row.master_id); const key = DAYK[row.dow]; const slot = `${row.start}-${row.end}`;
    wd[key] = wd[key] || {}; wd[key][slot] = (wd[key][slot] || 0) + 1;
  }
  const realRes = await pool.query(
    `SELECT master_id, EXTRACT(DOW FROM (starts_at AT TIME ZONE 'Europe/Kyiv'))::int AS dow,
            to_char(MIN((starts_at AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS start,
            to_char(MAX((COALESCE(ends_at, starts_at + interval '1 hour') AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS end
       FROM appointments
      WHERE starts_at >= CURRENT_DATE - 56 AND starts_at < CURRENT_DATE + 35
        AND master_id IS NOT NULL AND COALESCE(status,'') NOT IN ('cancelled','noshow')
      GROUP BY master_id, dow HAVING COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kyiv')::date) >= 2`);
  const real = new Map();
  for (const row of realRes.rows) {
    if (!real.has(row.master_id)) real.set(row.master_id, {});
    real.get(row.master_id)[DAYK[row.dow]] = { start: row.start, end: row.end };
  }

  const weekFor = (m) => {
    const tmpl = m.schedule_json || {};
    const wd = agg.get(m.id) || {}; const rl = real.get(m.id) || {};
    const week = {};
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].forEach((k) => {
      if (wd[k]) { const best = Object.entries(wd[k]).sort((a, b) => b[1] - a[1])[0][0]; const [s, e] = best.split('-'); week[k] = { start: s, end: e, source: 'beautypro' }; }
      else if (tmpl[k]) week[k] = { start: tmpl[k].start, end: tmpl[k].end, source: 'template' };
      else if (rl[k]) week[k] = { start: rl[k].start, end: rl[k].end, source: 'auto' };
      else week[k] = null;
    });
    return week;
  };

  const items = mrows.map((m) => {
    const week = weekFor(m);
    const ex = (m.schedule_json && m.schedule_json.exceptions) || {};
    const eMap = explMap.get(m.id) || {};
    const days = dates.map((dt) => {
      if (eMap[dt]) {
        const rr = eMap[dt];
        return rr.off ? { date: dt, off: true, source: rr.source } : { date: dt, start: rr.start, end: rr.end, off: false, source: rr.source };
      }
      if (ex[dt] && ex[dt].off) return { date: dt, off: true, source: 'exception' };
      const dow = new Date(dt + 'T00:00:00Z').getUTCDay();
      const wk = week[DAYK[dow]];
      if (wk) return { date: dt, start: wk.start, end: wk.end, off: false, source: wk.source };
      return { date: dt, off: true, source: 'pattern' };
    });
    return { id: m.id, name: m.name, specialty: m.specialty, avatar: m.avatar, days };
  });

  return { ym, daysInMonth, dates, items };
}

// Кількість робочих змін (днів з годинами, не вихідних) per master за місяць.
// Повертає Map<master_id, number> — те саме число, що бачить адмін у сітці графіка.
async function shiftDaysByMaster(pool, ym) {
  const grid = await buildMonthGrid(pool, ym);
  const map = new Map();
  for (const it of grid.items) {
    map.set(it.id, it.days.filter(d => !d.off).length);
  }
  return map;
}

// Кількість робочих змін КОНКРЕТНОГО майстра у діапазоні [from,to] (включно).
// Те саме джерело, що сітка графіка — використовується у розрахунку ЗП за фікс/день,
// щоб майстер отримував за реально відпрацьовані зміни, а не за календарні дні.
async function shiftDaysForMasterInRange(pool, masterId, from, to) {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  // перебираємо місяці діапазону
  const months = new Set();
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    months.add(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  const fromStr = from, toStr = to;
  let count = 0;
  for (const ym of months) {
    const grid = await buildMonthGrid(pool, ym);
    const it = grid.items.find(x => x.id === Number(masterId));
    if (!it) continue;
    count += it.days.filter(d => !d.off && d.date >= fromStr && d.date <= toStr).length;
  }
  return count;
}

// Зміни + доступні хвилини per master у діапазоні [from,to] — для utilization (% завантаження).
// Хвилини рахуємо з годин кожної робочої зміни сітки (end-start). Повертає Map<id,{shifts,minutes}>.
async function shiftStatsByMasterInRange(pool, from, to) {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  const out = new Map();
  if (isNaN(start) || isNaN(end) || end < start) return out;
  const months = new Set();
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    months.add(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  const toMin = (hhmm) => { const m = /^(\d{2}):(\d{2})$/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
  for (const ym of months) {
    const grid = await buildMonthGrid(pool, ym);
    for (const it of grid.items) {
      for (const d of it.days) {
        if (d.off || d.date < from || d.date > to) continue;
        const mins = Math.max(0, toMin(d.end) - toMin(d.start));
        const cell = out.get(it.id) || { shifts: 0, minutes: 0 };
        cell.shifts += 1; cell.minutes += mins;
        out.set(it.id, cell);
      }
    }
  }
  return out;
}

module.exports = { buildMonthGrid, shiftDaysByMaster, shiftDaysForMasterInRange, shiftStatsByMasterInRange, DAYK };
