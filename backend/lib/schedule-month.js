/* schedule-month.js — єдине джерело правди для місячної сітки графіків.
   Використовується і у GET /api/schedule/month (візуальна сітка), і у
   GET /api/reports/monthly-plan (кількість змін для плану обороту), і у
   розрахунку ЗП за фікс/день, і у utilization.
   Раніше ці місця рахували зміни по-різному → цифри розходились. Тепер усі
   викликають buildMonthGrid → числа завжди збігаються.

   Нотатка #150 (Власник): «генерація графіків на місяці вперед псує і минулі
   графіки, додає непрацюючих співробітників і декого дублює». Три корені:
   1) Тижневий шаблон рахувався по вікну [сьогодні-7 .. сьогодні+35]. Щойно
      згенеровані МАЙБУТНІ зміни потрапляли у це вікно і ставали «історією»,
      якою потім домальовувались МИНУЛІ місяці → минуле перемальовувалось під
      новий графік. Тепер вікно історії — тільки минуле [сьогодні-56 .. сьогодні].
   2) Минулі дні домальовувались шаблоном/патерном. Минуле не прогнозують:
      тепер минулий день = факт (явний запис у графіку або реальні візити),
      без домальовування шаблоном.
   3) У сітку потрапляли рядки-облікові записи персоналу (створені під логін),
      які дублюють живого співробітника з тим самим імʼям. Тепер список
      співробітників графіка — одна функція listScheduleStaff() з дедуплікацією,
      і генератор графіків пише зміни ТІЛЬКИ цим людям. */

const DAYK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Сьогоднішня дата салону (Київ) у форматі YYYY-MM-DD. Порівнюємо дати рядками.
function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

const nameKey = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

/* Єдиний список співробітників, які мають бути у графіку роботи.
   Беремо активних, хто надає послуги, або адміністраторів (адміни у графіку — прохання
   Босса 04.07, вони теж виходять на зміни). Далі прибираємо дублі.

   Дубль = рядок з ТИМ САМИМ імʼям, у якого немає жодної ознаки реальної роботи:
   ні візитів, ні графіка із зовнішнього джерела (стара CRM), ні legacy_ref.
   Це рівно ті рядки, що зʼявляються при заведенні логіна співробітнику, коли
   людина вже є у базі. Прибираємо лише коли в групі є «сильний» рядок —
   двох різних живих майстрів з однаковим імʼям НЕ чіпаємо.
   Нічого не видаляємо з бази: рядок просто не бере участі у графіку. */
async function listScheduleStaff(pool) {
  const rows = (await pool.query(
    `SELECT m.id, m.name, m.specialty, m.avatar, m.schedule_json, m.legacy_ref, m.staff_role,
            COALESCE(m.provides_services, true) AS provides_services,
            COALESCE(a.cnt, 0)::int AS appt_cnt,
            COALESCE(d.cnt, 0)::int AS ext_cnt
       FROM masters m
       LEFT JOIN (SELECT master_id, COUNT(*) cnt FROM appointments
                   WHERE master_id IS NOT NULL GROUP BY master_id) a ON a.master_id = m.id
       LEFT JOIN (SELECT master_id, COUNT(*) cnt FROM master_schedule_days
                   WHERE source IS DISTINCT FROM 'manual' GROUP BY master_id) d ON d.master_id = m.id
      WHERE m.active = true
        AND (COALESCE(m.provides_services, true) = true OR m.staff_role = 'admin')
      ORDER BY (m.staff_role = 'admin') ASC, m.name`
  )).rows;

  const isWeak = (r) => !r.appt_cnt && !r.ext_cnt && !r.legacy_ref;
  const groups = new Map();
  for (const r of rows) {
    const k = nameKey(r.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dropped = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    if (!g.some((r) => !isWeak(r))) continue; // усі однаково «порожні» — не вгадуємо
    for (const r of g) if (isWeak(r)) dropped.push(r.id);
  }
  const drop = new Set(dropped);
  return { staff: rows.filter((r) => !drop.has(r.id)), duplicates: dropped };
}

// Повертає { ym, daysInMonth, dates:[...], items:[{ id,name,specialty,avatar, days:[{date,off,start,end,source}] }] }
async function buildMonthGrid(pool, ym) {
  ym = /^\d{4}-\d{2}$/.test(ym || '') ? ym : new Date().toISOString().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const daysInMonth = new Date(Y, M, 0).getDate();
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth).padStart(2, '0')}`;
  const today = kyivToday();
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) dates.push(`${ym}-${String(d).padStart(2, '0')}`);

  const { staff: mrows } = await listScheduleStaff(pool);

  // Явні per-day записи цього місяця (найвищий пріоритет: ручні + з стара CRM)
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

  // ФАКТ минулих днів: день, у який майстер реально приймав клієнтів, вважається
  // робочим навіть якщо явного запису у графіку немає. Години — від першого запису
  // до кінця останнього. Це факт, а не прогноз, тому минуле ним заповнювати чесно.
  const factRes = await pool.query(
    `SELECT master_id,
            to_char((starts_at AT TIME ZONE 'Europe/Kyiv')::date,'YYYY-MM-DD') AS d,
            to_char(MIN((starts_at AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS start,
            to_char(MAX((COALESCE(ends_at, starts_at + interval '1 hour') AT TIME ZONE 'Europe/Kyiv')::time),'HH24:MI') AS end
       FROM appointments
      WHERE starts_at >= ($1::date - 1) AND starts_at < ($2::date + 2)
        AND master_id IS NOT NULL AND COALESCE(status,'') NOT IN ('cancelled','noshow')
      GROUP BY 1, 2`, [first, last]);
  const factMap = new Map();
  for (const row of factRes.rows) {
    if (!factMap.has(row.master_id)) factMap.set(row.master_id, {});
    factMap.get(row.master_id)[row.d] = { start: row.start, end: row.end };
  }

  // Тижневий шаблон для СЬОГОДНІ і МАЙБУТНЬОГО: історична агрегація (найчастіший слот
  // per день тижня) > template > auto(реальні візити).
  // Вікно історії — ТІЛЬКИ минуле. Раніше було [-7..+35]: свіжозгенеровані майбутні
  // зміни ставали «історією» і перемальовували минулі місяці (нотатка #150).
  const bp = await pool.query(
    `SELECT master_id, EXTRACT(DOW FROM work_date)::int AS dow,
            to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
       FROM master_schedule_days
      WHERE work_date BETWEEN CURRENT_DATE - 56 AND CURRENT_DATE AND start_time IS NOT NULL`);
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
      WHERE starts_at >= CURRENT_DATE - 56 AND starts_at < CURRENT_DATE + 1
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
      if (wd[k]) { const best = Object.entries(wd[k]).sort((a, b) => b[1] - a[1])[0][0]; const [s, e] = best.split('-'); week[k] = { start: s, end: e, source: 'history' }; }
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
    const fMap = factMap.get(m.id) || {};
    const days = dates.map((dt) => {
      if (eMap[dt]) {
        const rr = eMap[dt];
        return rr.off ? { date: dt, off: true, source: rr.source } : { date: dt, start: rr.start, end: rr.end, off: false, source: rr.source };
      }
      if (ex[dt] && ex[dt].off) return { date: dt, off: true, source: 'exception' };
      // Минулий день без явного запису — тільки факт візитів. Шаблоном не домальовуємо:
      // інакше зміна графіка на майбутнє заднім числом «переписує» минуле (нотатка #150).
      if (dt < today) {
        const f = fMap[dt];
        return f ? { date: dt, start: f.start, end: f.end, off: false, source: 'fact' }
                 : { date: dt, off: true, source: 'fact' };
      }
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

module.exports = { buildMonthGrid, shiftDaysByMaster, shiftDaysForMasterInRange, shiftStatsByMasterInRange, listScheduleStaff, kyivToday, DAYK };
