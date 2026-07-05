/* FIN-10 KPI Branches — KPI и бенчмаркинг филиалов.
 *
 * Метрики считаются вживую из appointments (выручка, визиты, новые клиенты,
 * средний чек) с группировкой по branch_id. Бенчмаркинг = сравнение филиалов,
 * рейтинг. План vs факт — из fin_branch_targets. Drill-down до мастера.
 * Для одного салона это один филиал, но модуль готов к сети.
 *
 * GET /api/kpi-branches?from&to            — KPI всех филиалов + рейтинг
 * GET /api/kpi-branches/:id?from&to        — детали филиала + drill-down мастеров
 * GET /api/kpi-branches/:id/plan-fact?month — план vs факт
 * GET /api/kpi-branches/targets?month       — цели филиалов
 * PUT /api/kpi-branches/targets             — задать цель филиала
 */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('kpi_branches.read');
const MANAGE = requirePerm('kpi_branches.manage');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateBounds(req) {
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0,10);
  const from = DATE_RE.test(req.query.from || '') ? req.query.from
    : new Date(Date.now() - 30*864e5).toISOString().slice(0,10);
  return { from, to };
}

// успешные/проведённые визиты
const DONE = `a.status IN ('done','completed','paid','finished','closed')`;
// отменённые/неявки (в БД встречается и 'noshow' без подчёркивания)
const CANCELLED = `a.status IN ('cancelled','canceled','no_show','noshow')`;

// У исторических записей branch_id пуст (импорт из Букона/BeautyPro не знал о филиалах).
// Такие визиты относим к главному (минимальному активному) филиалу, иначе все KPI = 0.
async function defaultBranchId() {
  const r = await pool.query(`SELECT MIN(id) AS id FROM branches WHERE is_active`);
  return (r.rows[0] && r.rows[0].id) || 0;
}

// ── KPI всех филиалов + рейтинг ──────────────────────
router.get('/', READ, async (req, res) => {
  try {
    const { from, to } = dateBounds(req);
    const dflt = await defaultBranchId();
    const r = await pool.query(`
      WITH agg AS (
        SELECT b.id, b.name, b.code,
          COUNT(*) FILTER (WHERE ${DONE}) AS visits,
          COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue,
          COUNT(DISTINCT a.client_id) FILTER (WHERE ${DONE}) AS clients,
          COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled
        FROM branches b
        LEFT JOIN appointments a ON COALESCE(a.branch_id,$3)=b.id
          AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
        WHERE b.is_active
        GROUP BY b.id, b.name, b.code
      )
      SELECT *,
        CASE WHEN visits>0 THEN ROUND(revenue/visits,2) ELSE 0 END AS avg_check,
        CASE WHEN (visits+cancelled)>0 THEN ROUND(100.0*visits/(visits+cancelled),1) ELSE 0 END AS completion_rate
      FROM agg
      ORDER BY revenue DESC`, [from, to, dflt]);
    // рейтинг по выручке
    const ranked = r.rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
    const totals = ranked.reduce((acc, x) => ({
      revenue: acc.revenue + Number(x.revenue),
      visits: acc.visits + Number(x.visits),
      clients: acc.clients + Number(x.clients),
    }), { revenue: 0, visits: 0, clients: 0 });
    res.json({ period: { from, to }, branches: ranked, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Детали филиала + drill-down мастеров ─────────────
router.get('/:id(\\d+)', READ, async (req, res) => {
  try {
    const { from, to } = dateBounds(req);
    const id = req.params.id;
    const branch = await pool.query(`SELECT id,name,code,address,city FROM branches WHERE id=$1`, [id]);
    if (!branch.rowCount) return res.status(404).json({ error: 'branch_not_found' });
    const dflt = await defaultBranchId();
    const kpi = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ${DONE}) AS visits,
        COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue,
        COUNT(DISTINCT a.client_id) FILTER (WHERE ${DONE}) AS clients,
        COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled
      FROM appointments a
      WHERE COALESCE(a.branch_id,$4)=$1 AND a.starts_at >= $2::date AND a.starts_at < ($3::date + 1)`,
      [id, from, to, dflt]);
    const masters = await pool.query(`
      SELECT COALESCE(NULLIF(m.name,''),'—') AS master,
        COUNT(*) FILTER (WHERE ${DONE}) AS visits,
        COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue
      FROM appointments a
      LEFT JOIN masters m ON m.id=a.master_id
      WHERE COALESCE(a.branch_id,$4)=$1 AND a.starts_at >= $2::date AND a.starts_at < ($3::date + 1)
      GROUP BY m.name ORDER BY revenue DESC`, [id, from, to, dflt]);
    const k = kpi.rows[0];
    k.avg_check = Number(k.visits) > 0 ? Math.round(Number(k.revenue)/Number(k.visits)*100)/100 : 0;
    res.json({ period: { from, to }, branch: branch.rows[0], kpi: k, masters: masters.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── План vs факт ─────────────────────────────────────
router.get('/:id(\\d+)/plan-fact', READ, async (req, res) => {
  try {
    const id = req.params.id;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month
      : new Date().toISOString().slice(0,7);
    const from = `${month}-01`;
    const t = await pool.query(
      `SELECT revenue_target,visits_target,new_clients_target,occupancy_target
       FROM fin_branch_targets WHERE branch_id=$1 AND period_month=$2`, [id, month]);
    const dflt = await defaultBranchId();
    const fact = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ${DONE}) AS visits,
        COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue,
        COUNT(DISTINCT a.client_id) FILTER (WHERE ${DONE}) AS clients
      FROM appointments a
      WHERE COALESCE(a.branch_id,$3)=$1 AND to_char(a.starts_at,'YYYY-MM')=$2`, [id, month, dflt]);
    const tgt = t.rows[0] || { revenue_target:0, visits_target:0, new_clients_target:0, occupancy_target:0 };
    const f = fact.rows[0];
    const pct = (fv, tv) => Number(tv) > 0 ? Math.round(100*Number(fv)/Number(tv)) : null;
    res.json({
      month, target: tgt, fact: f,
      progress: {
        revenue: pct(f.revenue, tgt.revenue_target),
        visits: pct(f.visits, tgt.visits_target),
        new_clients: pct(f.clients, tgt.new_clients_target),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Цели филиалов ────────────────────────────────────
router.get('/targets', READ, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month
      : new Date().toISOString().slice(0,7);
    const r = await pool.query(
      `SELECT t.*, b.name AS branch_name FROM fin_branch_targets t
       LEFT JOIN branches b ON b.id=t.branch_id
       WHERE t.period_month=$1 ORDER BY b.name`, [month]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/targets', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.branch_id || !b.period_month) return res.status(400).json({ error: 'branch_id_and_period_required' });
    const r = await pool.query(
      `INSERT INTO fin_branch_targets (branch_id,period_month,revenue_target,visits_target,new_clients_target,occupancy_target)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,branch_id,period_month) DO UPDATE SET
         revenue_target=EXCLUDED.revenue_target, visits_target=EXCLUDED.visits_target,
         new_clients_target=EXCLUDED.new_clients_target, occupancy_target=EXCLUDED.occupancy_target,
         updated_at=NOW()
       RETURNING *`,
      [b.branch_id, b.period_month, b.revenue_target||0, b.visits_target||0, b.new_clients_target||0, b.occupancy_target||0]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Бенчмаркінг: порівняння філіалів за ключовими метриками ─────────────────
router.get('/benchmark', READ, async (req, res) => {
  try {
    const { from, to } = dateBounds(req);
    const dflt = await defaultBranchId();
    const r = await pool.query(`
      WITH agg AS (
        SELECT b.id, b.name, b.code,
          COUNT(*) FILTER (WHERE ${DONE}) AS visits,
          COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue,
          COUNT(DISTINCT a.client_id) FILTER (WHERE ${DONE}) AS clients,
          COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled,
          COUNT(*) AS total_slots
        FROM branches b
        LEFT JOIN appointments a ON COALESCE(a.branch_id,$3)=b.id
          AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
        WHERE b.is_active
        GROUP BY b.id, b.name, b.code
      ),
      with_metrics AS (
        SELECT *,
          CASE WHEN visits>0 THEN ROUND(revenue/visits,2) ELSE 0 END AS avg_check,
          CASE WHEN total_slots>0 THEN ROUND(100.0*visits/total_slots,1) ELSE 0 END AS occupancy,
          CASE WHEN (visits+cancelled)>0 THEN ROUND(100.0*cancelled/(visits+cancelled),1) ELSE 0 END AS cancel_rate
        FROM agg
      ),
      ranked AS (
        SELECT *,
          RANK() OVER (ORDER BY revenue DESC) AS rev_rank,
          RANK() OVER (ORDER BY avg_check DESC) AS avgcheck_rank,
          RANK() OVER (ORDER BY visits DESC) AS visits_rank,
          RANK() OVER (ORDER BY clients DESC) AS clients_rank,
          RANK() OVER (ORDER BY occupancy DESC) AS occ_rank,
          COUNT(*) OVER () AS total_count
        FROM with_metrics
      )
      SELECT *,
        ROUND(100.0*(total_count - rev_rank)/(NULLIF(total_count-1,0)::numeric),1) AS rev_percentile,
        ROUND(100.0*(total_count - avgcheck_rank)/(NULLIF(total_count-1,0)::numeric),1) AS avgcheck_percentile,
        ROUND(100.0*(total_count - visits_rank)/(NULLIF(total_count-1,0)::numeric),1) AS visits_percentile,
        ROUND(100.0*(total_count - occ_rank)/(NULLIF(total_count-1,0)::numeric),1) AS occ_percentile,
        -- сумарний бал (середнє перцентилів, вище = краще)
        ROUND((
          COALESCE(100.0*(total_count - rev_rank)/(NULLIF(total_count-1,0)::numeric),50) +
          COALESCE(100.0*(total_count - avgcheck_rank)/(NULLIF(total_count-1,0)::numeric),50) +
          COALESCE(100.0*(total_count - visits_rank)/(NULLIF(total_count-1,0)::numeric),50) +
          COALESCE(100.0*(total_count - occ_rank)/(NULLIF(total_count-1,0)::numeric),50)
        ) / 4, 1) AS total_score
      FROM ranked
      ORDER BY total_score DESC`, [from, to, dflt]);

    const count = r.rows.length;
    const top25 = Math.ceil(count * 0.25);
    const bot25 = Math.floor(count * 0.75);
    const benchmark = r.rows.map((row, idx) => ({
      ...row,
      tier: idx < top25 ? 'top' : (idx >= bot25 ? 'bottom' : 'mid')
    }));
    res.json({ period: { from, to }, benchmark });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Зведення по мережі (best/worst/totals) ──────────────────────────────────
router.get('/network-summary', READ, async (req, res) => {
  try {
    const { from, to } = dateBounds(req);
    const dflt = await defaultBranchId();
    const r = await pool.query(`
      WITH agg AS (
        SELECT b.id, b.name,
          COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id), COALESCE(a.real_amount,a.price))) FILTER (WHERE ${DONE}),0) AS revenue,
          COUNT(*) FILTER (WHERE ${DONE}) AS visits,
          COUNT(DISTINCT a.client_id) FILTER (WHERE ${DONE}) AS clients,
          COUNT(*) AS total_slots
        FROM branches b
        LEFT JOIN appointments a ON COALESCE(a.branch_id,$3)=b.id
          AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
        WHERE b.is_active
        GROUP BY b.id, b.name
      )
      SELECT
        SUM(revenue) AS total_revenue,
        SUM(visits) AS total_visits,
        SUM(clients) AS total_clients,
        COUNT(*) AS branch_count,
        CASE WHEN SUM(visits)>0 THEN ROUND(SUM(revenue)/SUM(visits),2) ELSE 0 END AS network_avg_check,
        CASE WHEN SUM(total_slots)>0 THEN ROUND(100.0*SUM(visits)/SUM(total_slots),1) ELSE 0 END AS avg_occupancy,
        (SELECT name FROM agg ORDER BY revenue DESC LIMIT 1) AS best_branch_name,
        (SELECT revenue FROM agg ORDER BY revenue DESC LIMIT 1) AS best_branch_revenue,
        (SELECT name FROM agg ORDER BY revenue ASC LIMIT 1) AS worst_branch_name,
        (SELECT revenue FROM agg ORDER BY revenue ASC LIMIT 1) AS worst_branch_revenue
      FROM agg`, [from, to, dflt]);
    res.json({ period: { from, to }, summary: r.rows[0] || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
