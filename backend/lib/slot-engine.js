/* ═══════════════════════════════════════════════════════════════
   Власний движок вільних слотів — рахує з нашої CRM, без BeautyPro.

   Джерела:
     master_schedule_days  — графік роботи майстрів (start_time/end_time, NULL = вихідний)
     appointments          — зайняті інтервали (booked/confirmed/arrived/done)
     booking_settings      — min_lead_minutes, slot_step_minutes, max_horizon_days

   Часова модель: всі розрахунки в ХВИЛИНАХ ВІД КИЇВСЬКОЇ ПІВНОЧІ дня.
   БД живе в GMT → перетворення ТІЛЬКИ явним AT TIME ZONE 'Europe/Kyiv'.
   Слот: { date:'YYYY-MM-DD', label:'15:00', startMin, endMin, masterId }
   ═══════════════════════════════════════════════════════════════ */

const KYIV = 'Europe/Kyiv';
const BUSY_STATUSES = ['booked', 'confirmed', 'arrived', 'done'];

const pad = n => String(n).padStart(2, '0');
const minToLabel = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KYIV }).format(new Date());
}
function kyivNowMin() {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: KYIV, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
// 'YYYY-MM-DD' + днів → 'YYYY-MM-DD' (без залежності від TZ сервера)
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// налаштування запису (кеш 5 хв)
let _setCache = null, _setAt = 0;
async function getSettings(pool) {
  if (_setCache && Date.now() - _setAt < 5 * 60 * 1000) return _setCache;
  let row = {};
  try { row = (await pool.query(`SELECT * FROM booking_settings LIMIT 1`)).rows[0] || {}; } catch (_) {}
  _setCache = {
    leadMin: Number(row.min_lead_minutes) > 0 ? Number(row.min_lead_minutes) : 30,
    stepMin: Number(row.slot_step_minutes) > 0 ? Number(row.slot_step_minutes) : 15,
    horizonDays: Number(row.max_horizon_days) > 0 ? Number(row.max_horizon_days) : 90,
  };
  _setAt = Date.now();
  return _setCache;
}

/**
 * Вільні слоти на конкретну дату.
 * masterIds — внутрішні id майстрів у порядку пріоритету (online_rank).
 * Дедуп по часу: один час = одна кнопка, майстер — перший вільний за пріоритетом.
 */
async function freeSlotsForDate(pool, { date, masterIds, durationMin, dedupe = true, window = null }) {
  if (!masterIds || !masterIds.length) return [];
  const st = await getSettings(pool);
  const today = kyivToday();
  if (date < today) return [];

  // мінімальний старт: сьогодні = зараз + lead, округлено вгору до кроку
  let minStart = 0;
  if (date === today) minStart = Math.ceil((kyivNowMin() + st.leadMin) / st.stepMin) * st.stepMin;

  // графік майстрів на день
  const sched = await pool.query(
    `SELECT master_id,
            EXTRACT(HOUR FROM start_time)::int*60 + EXTRACT(MINUTE FROM start_time)::int AS s_min,
            EXTRACT(HOUR FROM end_time)::int*60   + EXTRACT(MINUTE FROM end_time)::int   AS e_min
       FROM master_schedule_days
      WHERE work_date = $1::date AND master_id = ANY($2::int[])
        AND start_time IS NOT NULL AND end_time IS NOT NULL`,
    [date, masterIds]
  );
  if (!sched.rows.length) return [];

  // зайнятість: записи, що перетинають цей київський день (хвилини від півночі, кламп 0..1440)
  const busyQ = await pool.query(
    `WITH day AS (SELECT ($1::date)::timestamp AT TIME ZONE '${KYIV}' AS d0,
                         (($1::date + 1))::timestamp AT TIME ZONE '${KYIV}' AS d1)
     SELECT a.master_id,
            GREATEST(0,    FLOOR(EXTRACT(EPOCH FROM (a.starts_at - day.d0)) / 60))::int AS s_min,
            LEAST(1440, CEIL(EXTRACT(EPOCH FROM (a.ends_at   - day.d0)) / 60))::int AS e_min
       FROM appointments a, day
      WHERE a.master_id = ANY($2::int[])
        AND a.status = ANY($3::text[])
        AND a.starts_at < day.d1 AND a.ends_at > day.d0`,
    [date, masterIds, BUSY_STATUSES]
  );
  const busyBy = new Map();
  for (const b of busyQ.rows) {
    if (!busyBy.has(b.master_id)) busyBy.set(b.master_id, []);
    busyBy.get(b.master_id).push(b);
  }

  // порядок пріоритету майстрів = порядок masterIds
  const prio = new Map(masterIds.map((id, i) => [Number(id), i]));
  const schedBy = new Map(sched.rows.map(r => [Number(r.master_id), r]));

  const out = [];
  for (const mid of masterIds.map(Number)) {
    const s = schedBy.get(mid);
    if (!s) continue;
    const busy = busyBy.get(mid) || [];
    const first = Math.max(Math.ceil(s.s_min / st.stepMin) * st.stepMin, minStart);
    for (let t = first; t + durationMin <= s.e_min; t += st.stepMin) {
      const clash = busy.some(b => b.s_min < t + durationMin && b.e_min > t);
      if (!clash) out.push({ date, label: minToLabel(t), startMin: t, endMin: t + durationMin, masterId: mid });
    }
  }
  out.sort((a, b) => a.startMin - b.startMin || prio.get(a.masterId) - prio.get(b.masterId));
  // побажання клієнта «після обіду / зранку / о 15» — фільтр по вікну
  const winFiltered = Array.isArray(window) && window.length === 2
    ? out.filter(s => s.startMin >= window[0] && s.startMin <= window[1])
    : out;
  if (!dedupe) return winFiltered;
  const seen = new Set(), uniq = [];
  for (const s of winFiltered) { if (!seen.has(s.label)) { seen.add(s.label); uniq.push(s); } }
  return uniq;
}

/**
 * Найближчі вільні вікна по днях уперед (для «запису в 2 кліки»).
 * Повертає до `limit` слотів, максимум `perDay` на день — щоб клієнт бачив вибір днів.
 */
async function nearestSlots(pool, { masterIds, durationMin, days = 14, limit = 6, perDay = 3, window = null, fromDate = null }) {
  const out = [];
  const today = fromDate || kyivToday();
  for (let i = 0; i < days && out.length < limit; i++) {
    const date = addDays(today, i);
    const slots = await freeSlotsForDate(pool, { date, masterIds, durationMin, window });
    // рівномірно: ранок/день/вечір, а не 3 підряд зранку
    const picked = [];
    if (slots.length <= perDay) picked.push(...slots);
    else {
      const idx = new Set([0, Math.floor(slots.length / 2), slots.length - 1]);
      [...idx].slice(0, perDay).forEach(j => picked.push(slots[j]));
      picked.sort((a, b) => a.startMin - b.startMin);
    }
    for (const s of picked) { if (out.length < limit) out.push(s); }
  }
  return out;
}

/** timestamptz-вираз для вставки: київська дата+хвилини → UTC. Використання в SQL:
 *  starts_at = ($d::date::timestamp + make_interval(mins => $m)) AT TIME ZONE 'Europe/Kyiv' */
const TS_EXPR = (dParam, mParam) =>
  `(($${dParam}::date)::timestamp + make_interval(mins => $${mParam}::int)) AT TIME ZONE '${KYIV}'`;

module.exports = { freeSlotsForDate, nearestSlots, getSettings, kyivToday, kyivNowMin, addDays, minToLabel, TS_EXPR, BUSY_STATUSES };
