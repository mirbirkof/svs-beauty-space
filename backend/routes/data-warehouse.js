/* INF-07 Data Warehouse — аналитическое хранилище (star-schema).
 *
 * Прагматично: факт-таблица dwh_fact_visits + измерения денормализованы в неё
 * (мастер/услуга/категория/источник/статус/дата). ETL инкрементально (CDC по
 * src_appointment_id) переносит проведённые визиты из OLTP (appointments).
 * Запросы агрегаций идут по факт-таблице — не нагружают оперативную БД.
 * Источник данных для INF-08 BI и AI-04 Analytics.
 *
 * GET  /api/dwh/status            — состояние хранилища (объём, последний ETL)
 * POST /api/dwh/etl              — запустить инкрементальную загрузку
 * GET  /api/dwh/etl-runs         — история ETL
 * GET  /api/dwh/quality          — data quality checks
 * GET  /api/dwh/facts?dim&from&to — агрегация по измерению (star-schema срез)
 */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('dwh.read');
const MANAGE = requirePerm('dwh.manage');
const DONE = `a.status IN ('done','completed','paid','finished','closed')`;

// whitelist измерений (никакой интерполяции пользовательского ввода)
const DIMS = {
  master:   'master_name',
  service:  'service_name',
  category: 'service_category',
  source:   'source',
  status:   'status',
  day:      "to_char(visit_date,'YYYY-MM-DD')",
  month:    "to_char(visit_date,'YYYY-MM')",
};

// ── Состояние ────────────────────────────────────────
router.get('/status', READ, async (req, res) => {
  try {
    const f = await pool.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(MIN(visit_date)::text,'') AS min_date,
              COALESCE(MAX(visit_date)::text,'') AS max_date, COALESCE(SUM(revenue),0) AS revenue
       FROM dwh_fact_visits`);
    const last = await pool.query(
      `SELECT status, rows_loaded, finished_at FROM dwh_etl_runs
       WHERE pipeline='fact_visits' ORDER BY started_at DESC LIMIT 1`);
    res.json({ fact_visits: f.rows[0], last_etl: last.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ETL инкрементальная загрузка ─────────────────────
router.post('/etl', MANAGE, async (req, res) => {
  const t0 = Date.now();
  const run = await pool.query(
    `INSERT INTO dwh_etl_runs (pipeline,status) VALUES ('fact_visits','running') RETURNING id`);
  const runId = run.rows[0].id;
  try {
    // CDC: грузим только новые проведённые визиты (которых ещё нет в факт-таблице)
    const ins = await pool.query(`
      INSERT INTO dwh_fact_visits
        (visit_date,master_name,service_name,service_category,source,status,revenue,visits,src_appointment_id)
      SELECT a.starts_at::date,
             COALESCE(NULLIF(m.name,''), a.client_name, '—'),
             COALESCE(NULLIF(s.name,''), NULLIF(a.services_text,''), '—'),
             COALESCE(NULLIF(s.category,''), '—'),
             COALESCE(NULLIF(a.source,''),'—'),
             a.status,
             COALESCE(a.real_amount, a.price, 0), 1, a.id
      FROM appointments a
      LEFT JOIN masters m ON m.id=a.master_id
      LEFT JOIN services s ON s.id=a.service_id
      WHERE ${DONE} AND a.starts_at IS NOT NULL
      ON CONFLICT (tenant_id, src_appointment_id) DO NOTHING
      RETURNING id`);
    // data-quality: визиты с нулевой/отрицательной выручкой
    const dq = await pool.query(`SELECT COUNT(*)::int AS n FROM dwh_fact_visits WHERE revenue <= 0`);
    const dur = Date.now() - t0;
    const r = await pool.query(
      `UPDATE dwh_etl_runs SET status='success', rows_loaded=$1, quality_issues=$2, duration_ms=$3, finished_at=NOW()
       WHERE id=$4 RETURNING *`,
      [ins.rowCount, dq.rows[0].n, dur, runId]);
    await logAction({ user: req.user, action: 'dwh.etl', entity: 'dwh_etl_runs', entity_id: runId, ip: req.ip });
    res.status(201).json({ ...r.rows[0], note: `Загружено ${ins.rowCount} новых визитов за ${dur} мс.` });
  } catch (e) {
    await pool.query(`UPDATE dwh_etl_runs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
      [String(e.message).slice(0,300), runId]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/etl-runs', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM dwh_etl_runs ORDER BY started_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Data quality ─────────────────────────────────────
router.get('/quality', READ, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total_rows,
        COUNT(*) FILTER (WHERE revenue <= 0)::int AS zero_revenue,
        COUNT(*) FILTER (WHERE master_name='—')::int AS missing_master,
        COUNT(*) FILTER (WHERE service_name='—')::int AS missing_service,
        COUNT(*) FILTER (WHERE visit_date IS NULL)::int AS missing_date
      FROM dwh_fact_visits`);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Star-schema срез ─────────────────────────────────
router.get('/facts', READ, async (req, res) => {
  try {
    const dimKey = String(req.query.dim || 'month');
    const dimSql = DIMS[dimKey];
    if (!dimSql) return res.status(400).json({ error: 'bad_dim', allowed: Object.keys(DIMS) });
    const where = [], vals = []; let i = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push(`visit_date >= $${i++}`); vals.push(req.query.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push(`visit_date <= $${i++}`); vals.push(req.query.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT ${dimSql} AS dimension, SUM(visits)::int AS visits, COALESCE(SUM(revenue),0) AS revenue,
              CASE WHEN SUM(visits)>0 THEN ROUND(SUM(revenue)/SUM(visits),2) ELSE 0 END AS avg_check
       FROM dwh_fact_visits ${w}
       GROUP BY ${dimSql} ORDER BY revenue DESC LIMIT 500`, vals);
    res.json({ dim: dimKey, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
