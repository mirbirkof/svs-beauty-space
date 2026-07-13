/* routes/insights.js — поведінкові прогнози (Босс 13.07: «не реагувати, а прогнозувати»).
   Етап 1, без ML — чесна статистика з історії візитів:
     GET /cancel-risk?date=YYYY-MM-DD  ризик скасування для записів дня (журнал/дашборд)
     GET /return-due                    «пора записатись»: особистий ритм клієнта вичерпано
     GET /master-ratings               зірки майстрам/салону від клієнтів (visit_ratings)
     GET /client/:id                   зведення для картки клієнта (ризик + ритм + оцінки)
   Всі запити йдуть у tenant-контексті (RLS) — кожен салон бачить лише своє. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const { getPool } = require('../db-pg');

const fail = (res, e) => {
  console.error('[insights]', e);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
};

// Ризик скасування: частка скасувань в історії клієнта (мін. 3 записи історії).
// high >= 50%, medium >= 30%. Часте вранішнє скасування добавим, коли cancelled_at накопичиться.
router.get('/cancel-risk', requirePerm('reports.read'), async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
    const rows = (await getPool().query(
      `SELECT a.id, a.starts_at, a.client_id, c.name AS client_name,
              st.done, st.cancelled, st.noshow,
              ROUND(st.cancelled::numeric / NULLIF(st.done + st.cancelled + st.noshow, 0) * 100) AS cancel_pct
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN LATERAL (
           SELECT count(*) FILTER (WHERE h.status = 'done')      AS done,
                  count(*) FILTER (WHERE h.status = 'cancelled') AS cancelled,
                  count(*) FILTER (WHERE h.status = 'noshow')    AS noshow
             FROM appointments h
            WHERE h.client_id = a.client_id AND h.id <> a.id
         ) st ON TRUE
        WHERE a.status IN ('booked', 'confirmed')
          AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date =
              COALESCE($1::date, (NOW() AT TIME ZONE 'Europe/Kyiv')::date)
        ORDER BY a.starts_at`, [date])).rows;
    const out = rows.map(r => {
      const hist = Number(r.done) + Number(r.cancelled) + Number(r.noshow);
      const pct = Number(r.cancel_pct) || 0;
      const risk = hist >= 3 && pct >= 50 ? 'high' : hist >= 3 && pct >= 30 ? 'medium' : 'low';
      return { ...r, history: hist, risk };
    });
    res.json({ rows: out, risky: out.filter(r => r.risk !== 'low').length });
  } catch (e) { fail(res, e); }
});

// «Пора записатись»: медіанний особистий інтервал (3+ проміжки) вичерпано у 1.5 раза.
// Не дублює winback (той б'є по фіксованих 35/50/75 днях) — тут особистий ритм.
router.get('/return-due', requirePerm('reports.read'), async (req, res) => {
  try {
    const rows = (await getPool().query(
      `WITH visits AS (
         SELECT client_id, starts_at,
                starts_at - LAG(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at) AS gap
           FROM appointments WHERE status = 'done'
       ), cad AS (
         SELECT client_id,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM gap) / 86400) AS median_days,
                max(starts_at) AS last_visit
           FROM visits WHERE gap IS NOT NULL
          GROUP BY client_id HAVING count(*) >= 3
       )
       SELECT c.id, c.name, c.phone,
              ROUND(cad.median_days)::int AS rhythm_days,
              ((NOW() AT TIME ZONE 'Europe/Kyiv')::date - (cad.last_visit AT TIME ZONE 'Europe/Kyiv')::date)::int AS days_since,
              ROUND(((NOW() AT TIME ZONE 'Europe/Kyiv')::date - (cad.last_visit AT TIME ZONE 'Europe/Kyiv')::date) - cad.median_days)::int AS overdue_days
         FROM cad JOIN clients c ON c.id = cad.client_id
        WHERE ((NOW() AT TIME ZONE 'Europe/Kyiv')::date - (cad.last_visit AT TIME ZONE 'Europe/Kyiv')::date) > cad.median_days * 1.5
          AND ((NOW() AT TIME ZONE 'Europe/Kyiv')::date - (cad.last_visit AT TIME ZONE 'Europe/Kyiv')::date) < 365
          AND NOT EXISTS (SELECT 1 FROM appointments f
                           WHERE f.client_id = c.id AND f.status IN ('booked','confirmed') AND f.starts_at > NOW())
        ORDER BY overdue_days DESC LIMIT 100`)).rows;
    res.json({ rows, total: rows.length });
  } catch (e) { fail(res, e); }
});

// Зірки від клієнтів: по майстрах + салон загалом
router.get('/master-ratings', requirePerm('reports.read'), async (req, res) => {
  try {
    const masters = (await getPool().query(
      `SELECT m.id, m.name,
              ROUND(AVG(vr.master_stars)::numeric, 1) AS avg_stars,
              COUNT(vr.master_stars)::int AS cnt
         FROM masters m
         JOIN visit_ratings vr ON vr.master_id = m.id AND vr.master_stars IS NOT NULL
        GROUP BY m.id, m.name ORDER BY avg_stars DESC NULLS LAST`)).rows;
    const salon = (await getPool().query(
      `SELECT ROUND(AVG(salon_stars)::numeric, 1) AS avg_stars, COUNT(salon_stars)::int AS cnt
         FROM visit_ratings WHERE salon_stars IS NOT NULL`)).rows[0];
    res.json({ masters, salon });
  } catch (e) { fail(res, e); }
});

// Зведення для картки клієнта: ризик + особистий ритм + які оцінки ставив
router.get('/client/:id', requirePerm('clients.read'), async (req, res) => {
  try {
    const cid = Number(req.params.id);
    if (!cid) return res.status(400).json({ error: 'bad-id' });
    const pool = getPool();
    const st = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='done')      AS done,
              count(*) FILTER (WHERE status='cancelled') AS cancelled,
              count(*) FILTER (WHERE status='noshow')    AS noshow
         FROM appointments WHERE client_id = $1`, [cid])).rows[0];
    const cad = (await pool.query(
      `WITH v AS (SELECT starts_at, starts_at - LAG(starts_at) OVER (ORDER BY starts_at) AS gap
                    FROM appointments WHERE client_id = $1 AND status = 'done')
       SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM gap)/86400))::int AS rhythm_days,
              ((NOW() AT TIME ZONE 'Europe/Kyiv')::date - (max(starts_at) AT TIME ZONE 'Europe/Kyiv')::date)::int AS days_since,
              count(gap)::int AS gaps
         FROM v WHERE gap IS NOT NULL`, [cid])).rows[0] || {};
    const ratings = (await pool.query(
      `SELECT vr.master_stars, vr.salon_stars, vr.created_at,
              COALESCE(NULLIF(m.online_title,''), m.name) AS master_name
         FROM visit_ratings vr LEFT JOIN masters m ON m.id = vr.master_id
        WHERE vr.client_id = $1 ORDER BY vr.created_at DESC LIMIT 5`, [cid])).rows;
    const hist = Number(st.done) + Number(st.cancelled) + Number(st.noshow);
    const pct = hist ? Math.round(Number(st.cancelled) / hist * 100) : 0;
    res.json({
      history: hist, done: Number(st.done), cancelled: Number(st.cancelled), noshow: Number(st.noshow),
      cancel_pct: pct,
      risk: hist >= 3 && pct >= 50 ? 'high' : hist >= 3 && pct >= 30 ? 'medium' : 'low',
      rhythm_days: cad.rhythm_days || null, days_since: cad.days_since ?? null,
      overdue: cad.rhythm_days && cad.days_since != null ? Math.max(0, cad.days_since - cad.rhythm_days) : null,
      ratings,
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
