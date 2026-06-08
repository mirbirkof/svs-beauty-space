/* Reports: P&L, KPI мастеров, RFM-сегментация, отток
   Все эндпоинты требуют reports.read */
const express = require('express');
const { Pool } = require('pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parsePeriod(q) {
  const end   = q.to   ? new Date(q.to)   : new Date();
  const start = q.from ? new Date(q.from) : new Date(end.getTime() - 30*86400*1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

// ── P&L (Profit & Loss) ─────────────────────────────────
// GET /api/reports/pnl?from=&to=
router.get('/pnl', requirePerm('reports.read'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);

    // Доход: paid-заказы магазина + услуги (из cash_operations или appointments)
    const revOrders = await pool.query(
      `SELECT COALESCE(SUM(total),0)::numeric AS rev, COUNT(*)::int AS cnt
         FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    );
    const revServices = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS rev, COUNT(*)::int AS cnt
         FROM cash_operations WHERE type='in' AND category='sale_service' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    );

    // COGS (себестоимость проданных товаров) — из stock_movements типа 'sale'
    const cogs = await pool.query(
      `SELECT COALESCE(SUM(ABS(qty_change) * COALESCE(cost_per_unit,0)),0)::numeric AS cogs
         FROM stock_movements
        WHERE movement_type='sale' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    ).catch(() => ({ rows: [{ cogs: 0 }] }));

    // Расходы по категориям из cash
    const exp = await pool.query(
      `SELECT category, COALESCE(SUM(amount),0)::numeric AS sum, COUNT(*)::int AS cnt
         FROM cash_operations WHERE type='out' AND created_at BETWEEN $1 AND $2
        GROUP BY category ORDER BY sum DESC`,
      [from, to]
    );

    const revenueProducts = Number(revOrders.rows[0].rev);
    const revenueServices = Number(revServices.rows[0].rev);
    const revenueTotal    = revenueProducts + revenueServices;
    const cogsTotal       = Number(cogs.rows[0].cogs);
    const grossProfit     = revenueTotal - cogsTotal;
    const expenseTotal    = exp.rows.reduce((s, r) => s + Number(r.sum), 0);
    const netProfit       = grossProfit - expenseTotal;

    res.json({
      period: { from, to },
      revenue: { products: revenueProducts, services: revenueServices, total: revenueTotal },
      cogs: cogsTotal,
      gross_profit: grossProfit,
      gross_margin_pct: revenueTotal > 0 ? Math.round(grossProfit / revenueTotal * 100) : 0,
      expenses: exp.rows,
      expense_total: expenseTotal,
      net_profit: netProfit,
      net_margin_pct: revenueTotal > 0 ? Math.round(netProfit / revenueTotal * 100) : 0,
      counts: { orders: revOrders.rows[0].cnt, service_ops: revServices.rows[0].cnt }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KPI мастеров ────────────────────────────────────────
// GET /api/reports/masters?from=&to=
router.get('/masters', requirePerm('reports.read'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);

    const r = await pool.query(
      `WITH appts AS (
         SELECT master_id,
                COUNT(*)::int                    AS total_appts,
                COUNT(*) FILTER (WHERE status='completed')::int AS done_appts,
                COUNT(*) FILTER (WHERE status='canceled')::int  AS canceled_appts,
                COUNT(*) FILTER (WHERE status='no_show')::int   AS no_show_appts,
                COUNT(DISTINCT client_id)::int   AS unique_clients,
                COALESCE(SUM(price),0)::numeric  AS revenue
           FROM appointments
          WHERE starts_at BETWEEN $1 AND $2
          GROUP BY master_id
       ),
       payroll AS (
         SELECT master_id::int AS master_id, COALESCE(SUM(total),0)::numeric AS payroll_sum
           FROM payroll_records
          WHERE period_start >= $1::date AND period_end <= $2::date
            AND master_id ~ '^\d+$'
          GROUP BY master_id::int
       )
       SELECT m.id, m.name,
              a.total_appts, a.done_appts, a.canceled_appts, a.no_show_appts,
              a.unique_clients, a.revenue,
              p.payroll_sum,
              CASE WHEN a.done_appts > 0
                   THEN ROUND(a.revenue / a.done_appts, 2)
                   ELSE 0 END AS avg_ticket,
              CASE WHEN a.total_appts > 0
                   THEN ROUND(a.canceled_appts::numeric / a.total_appts * 100, 1)
                   ELSE 0 END AS cancel_rate_pct
         FROM masters m
         LEFT JOIN appts a   ON a.master_id = m.id
         LEFT JOIN payroll p ON p.master_id = m.id
         WHERE a.total_appts > 0 OR p.payroll_sum > 0
         ORDER BY a.revenue DESC NULLS LAST`,
      [from, to]
    );

    res.json({ period: { from, to }, items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RFM-сегментация клиентов ────────────────────────────
// Recency / Frequency / Monetary, скор 1-5 по каждой оси
// GET /api/reports/rfm
router.get('/rfm', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `WITH base AS (
         SELECT c.id, c.name, c.phone,
                COALESCE(MAX(o.created_at), MAX(a.starts_at)) AS last_activity,
                COUNT(DISTINCT o.id) + COUNT(DISTINCT a.id)  AS frequency,
                COALESCE(SUM(o.total) FILTER (WHERE o.status='paid'),0)
                + COALESCE(SUM(a.price) FILTER (WHERE a.status='completed'),0) AS monetary
           FROM clients c
           LEFT JOIN orders o       ON o.client_id = c.id
           LEFT JOIN appointments a ON a.client_id = c.id
          GROUP BY c.id, c.name, c.phone
       ),
       filtered AS (
         SELECT * FROM base WHERE last_activity IS NOT NULL
       ),
       scored AS (
         SELECT id, name, phone, last_activity, frequency, monetary,
                EXTRACT(EPOCH FROM (NOW()-last_activity))/86400 AS recency_days,
                NTILE(5) OVER (ORDER BY last_activity DESC) AS r_score,
                NTILE(5) OVER (ORDER BY frequency ASC)      AS f_score,
                NTILE(5) OVER (ORDER BY monetary ASC)       AS m_score
           FROM filtered
       )
       SELECT id, name, phone,
              ROUND(recency_days)::int AS recency_days,
              frequency, monetary,
              r_score, f_score, m_score,
              CASE
                WHEN r_score >= 4 AND f_score >= 4 AND m_score >= 4 THEN 'champion'
                WHEN r_score >= 3 AND f_score >= 3                  THEN 'loyal'
                WHEN r_score >= 4 AND f_score <= 2                  THEN 'new'
                WHEN r_score <= 2 AND f_score >= 3                  THEN 'at_risk'
                WHEN r_score <= 2 AND f_score <= 2                  THEN 'lost'
                ELSE 'regular'
              END AS segment
         FROM scored
         ORDER BY monetary DESC
         LIMIT 1000`
    );

    // сводка по сегментам
    const summary = {};
    for (const row of r.rows) {
      const k = row.segment;
      if (!summary[k]) summary[k] = { count: 0, revenue: 0 };
      summary[k].count++;
      summary[k].revenue += Number(row.monetary);
    }

    res.json({ items: r.rows, count: r.rows.length, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Отток (churn) ───────────────────────────────────────
// Клиенты которые посещали раньше, но не приходили >90 дней
// GET /api/reports/churn?days=90
router.get('/churn', requirePerm('reports.read'), async (req, res) => {
  try {
    const days = Math.max(Number(req.query.days) || 90, 30);
    const r = await pool.query(
      `SELECT c.id, c.name, c.phone,
              MAX(a.starts_at) AS last_visit,
              COUNT(a.id)     AS total_visits,
              EXTRACT(EPOCH FROM (NOW()-MAX(a.starts_at)))/86400 AS days_since
         FROM clients c
         JOIN appointments a ON a.client_id=c.id AND a.status='completed'
        GROUP BY c.id, c.name, c.phone
        HAVING MAX(a.starts_at) < NOW() - INTERVAL '${days} days'
           AND COUNT(a.id) >= 2
        ORDER BY MAX(a.starts_at) ASC
        LIMIT 500`
    );
    res.json({ threshold_days: days, items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Сводный дашборд (одним запросом) ────────────────────
// GET /api/reports/dashboard
router.get('/dashboard', requirePerm('reports.read'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayRev, monthRev, lowStock, openShifts, churnCnt] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0)::numeric AS rev FROM orders WHERE status='paid' AND created_at >= $1`, [today.toISOString()]),
      pool.query(`SELECT COALESCE(SUM(total),0)::numeric AS rev FROM orders WHERE status='paid' AND created_at >= $1`, [monthStart.toISOString()]),
      pool.query(`SELECT COUNT(*)::int AS n FROM product_variants WHERE stock <= COALESCE(low_stock_threshold,5)`).catch(()=>({rows:[{n:0}]})),
      pool.query(`SELECT COUNT(*)::int AS n FROM cash_shifts WHERE status='open'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM (
         SELECT c.id FROM clients c
         JOIN appointments a ON a.client_id=c.id AND a.status='completed'
         GROUP BY c.id
         HAVING MAX(a.starts_at) < NOW() - INTERVAL '90 days' AND COUNT(a.id) >= 2
       ) t`),
    ]);

    res.json({
      revenue_today: Number(todayRev.rows[0].rev),
      revenue_month: Number(monthRev.rows[0].rev),
      low_stock_items: lowStock.rows[0].n,
      open_shifts: openShifts.rows[0].n,
      churn_clients: churnCnt.rows[0].n,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
