/* routes/pipeline.js — CRM-08 Visit Pipeline (воронка візита).
   Канбан-доска візитів на день поверх існуючих статусів appointments.
   Стадії = реальні статуси записів (booked/confirmed/done/noshow/cancelled) —
   жодної ризикованої міграції, повна сумісність з журналом і розкладом.
   Ручний перехід стадії робиться існуючим PATCH /api/schedule/appointments/:id
   (він списує розхідники при 'done') — тут лише читання дошки + статистика.
   Доступ: schedule.read (як журнал). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// усі GET — schedule.read (та сама модель доступу, що й журнал)
router.use((req, res, next) => requirePerm('schedule.read')(req, res, next));

// Стадії воронки = колонки канбану (порядок зліва направо)
const STAGES = [
  { code: 'booked',    name: 'Заплановані',  color: '#6366f1' },
  { code: 'confirmed', name: 'Підтверджені', color: '#0ea5e9' },
  { code: 'done',      name: 'Завершені',    color: '#16a34a' },
  { code: 'noshow',    name: 'Не прийшли',   color: '#dc2626' },
  { code: 'cancelled', name: 'Скасовані',    color: '#94a3b8' },
];

// Київська дата "сьогодні" якщо не передали date
function kyivToday() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date()); // YYYY-MM-DD
}

// GET /api/pipeline/board?date=YYYY-MM-DD&master_id=
// Канбан на день: колонки-стадії з картками візитів.
router.get('/board', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : kyivToday();
    const masterId = req.query.master_id ? Number(req.query.master_id) : null;

    const rows = await pool.query(
      `SELECT a.id, a.status, a.starts_at, a.ends_at, a.price, a.updated_at,
              COALESCE(NULLIF(a.client_name,''), c.name, 'Клієнт') AS client_name,
              COALESCE(NULLIF(a.services_text,''), s.name, '—')   AS service_name,
              m.name AS master_name,
              EXTRACT(EPOCH FROM (NOW() - a.starts_at))/60 AS mins_since_start
         FROM appointments a
         LEFT JOIN clients  c ON c.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN masters  m ON m.id = a.master_id
        WHERE (a.starts_at AT TIME ZONE 'Europe/Kiev')::date = $1::date
          AND ($2::int IS NULL OR a.master_id = $2)
          AND a.bp_state IS DISTINCT FROM 'bp_deleted'
        ORDER BY a.starts_at`,
      [date, masterId]
    );

    // SLA «зависання»: booked/confirmed і час початку вже минув >15 хв → червоний
    const STUCK_AFTER_MIN = 15;
    const byStage = {};
    for (const st of STAGES) byStage[st.code] = [];
    for (const r of rows.rows) {
      const code = byStage[r.status] ? r.status : null;
      if (!code) continue; // незнайомий статус — пропускаємо
      const mins = Math.round(Number(r.mins_since_start) || 0);
      const stuck = (r.status === 'booked' || r.status === 'confirmed') && mins > STUCK_AFTER_MIN;
      byStage[code].push({
        id: r.id,
        client_name: r.client_name,
        service_name: r.service_name,
        master_name: r.master_name || '—',
        starts_at: r.starts_at,
        price: r.price != null ? Math.round(Number(r.price)) : null,
        mins_since_start: mins,
        stuck,
      });
    }

    res.json({
      date,
      stages: STAGES.map(st => ({ ...st, count: byStage[st.code].length, appointments: byStage[st.code] })),
    });
  } catch (e) {
    console.error('[pipeline:board]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pipeline/stats?from=&to= — конверсія воронки + no-show за період
router.get('/stats', async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`(starts_at AT TIME ZONE 'Europe/Kiev')::date >= $${params.length}::date`); }
    if (to)   { params.push(to);   where.push(`(starts_at AT TIME ZONE 'Europe/Kiev')::date <= $${params.length}::date`); }
    if (!from && !to) where.push(`starts_at >= NOW() - INTERVAL '30 days'`);
    // Записи, видалені в BeautyPro (дублі, чистка адміном), синк позначає
    // status='cancelled', bp_state='bp_deleted'. Це НЕ скасування клієнтом —
    // не рахуємо їх у воронці, інакше відсоток відмін штучно завищений.
    where.push(`bp_state IS DISTINCT FROM 'bp_deleted'`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='done')::int      AS done,
              COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed,
              COUNT(*) FILTER (WHERE status='booked')::int    AS booked,
              COUNT(*) FILTER (WHERE status='noshow')::int    AS noshow,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
         FROM appointments ${w}`, params
    );
    const s = r.rows[0] || {};
    const total = s.total || 0;
    const finished = s.done + s.noshow + s.cancelled; // візити, що дійшли до результату
    res.json({
      total,
      counts: { booked: s.booked, confirmed: s.confirmed, done: s.done, noshow: s.noshow, cancelled: s.cancelled },
      done_rate:      total ? Math.round(s.done / total * 100) : 0,
      noshow_rate:    finished ? Math.round(s.noshow / finished * 100) : 0,
      cancel_rate:    total ? Math.round(s.cancelled / total * 100) : 0,
    });
  } catch (e) {
    console.error('[pipeline:stats]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
