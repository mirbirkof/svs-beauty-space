/* routes/manager.js — Панель керуючого (KPI однією картиною).
   GET /api/manager/kpi — оборот місяця vs план, закриття заявок, рекламації,
   нові/втрачені клієнти, активні майстри. Доступ: reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { shiftDaysByMaster } = require('../lib/schedule-month');

const router = express.Router();
const pool = getPool();

router.get('/kpi', requirePerm('reports.finance'), async (req, res) => {
  try {
    const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);
    const kyiv = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kiev' });
    const ym = kyiv().slice(0, 7);
    const [year, month] = ym.split('-').map(Number);

    // 1) Оборот місяця (каса: послуги+товари)
    const revRow = (await q(
      `SELECT COALESCE(SUM(amount),0)::numeric v
         FROM cash_operations
        WHERE type='in' AND category IN ('sale_service','sale_product')
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0] || { v: 0 };
    const revenue = Number(revRow.v);

    // 2) План місяця = Σ(plan_per_shift × змін у графіку) по активних майстрах
    let plan = 0;
    try {
      const plans = await q(
        `SELECT mp.master_id, mp.plan_per_shift, mp.plan_total, mp.auto_from_shifts
           FROM master_monthly_plans mp JOIN masters m ON m.id=mp.master_id AND COALESCE(m.active,true)=true
          WHERE mp.year=$1 AND mp.month=$2`, [year, month]);
      const grid = await shiftDaysByMaster(pool, ym).catch(() => new Map());
      for (const p of plans) {
        plan += p.auto_from_shifts ? Math.round(Number(p.plan_per_shift) * (grid.get(p.master_id) || 0)) : Number(p.plan_total);
      }
    } catch (_) { plan = 0; }
    const planPct = plan > 0 ? Math.round(revenue / plan * 100) : null;

    // 3) Закриття заявок (без bp_deleted синк-артефактів)
    const clRow = (await q(
      `SELECT COUNT(*) FILTER (WHERE status IN ('done','confirmed'))::int served,
              COUNT(*) FILTER (WHERE status IN ('noshow','cancelled'))::int lost
         FROM appointments
        WHERE starts_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')
          AND starts_at <= NOW() AND bp_state IS DISTINCT FROM 'bp_deleted'`))[0] || { served: 0, lost: 0 };
    const clFin = clRow.served + clRow.lost;
    const closurePct = clFin > 0 ? Math.round(clRow.served / clFin * 100) : null;

    // 4) Рекламації (відгуки ≤3★) + середній рейтинг за місяць
    const revw = (await q(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE rating<=3)::int neg,
              ROUND(AVG(rating)::numeric,1) avg_rating
         FROM reviews WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0]
      || { total: 0, neg: 0, avg_rating: null };

    // 5) Нові клієнти = ті, чий ПЕРШИЙ візит припав на цей місяць
    // (за датою створення не можна — там тисячі імпортованих контактів без візитів).
    const newCl = (await q(
      `WITH firsts AS (
         SELECT client_id, MIN(starts_at) first_visit
           FROM appointments
          WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL
          GROUP BY client_id)
       SELECT COUNT(*)::int n FROM firsts
        WHERE first_visit >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0] || { n: 0 };

    // 6) Активні майстри
    const mast = (await q(`SELECT COUNT(*)::int n FROM masters WHERE COALESCE(active,true)=true`))[0] || { n: 0 };

    res.json({
      period: ym,
      revenue, plan, plan_pct: planPct,
      closure: { pct: closurePct, served: clRow.served, finished: clFin, target: 80 },
      reviews: { total: Number(revw.total), negative: Number(revw.neg), avg_rating: revw.avg_rating != null ? Number(revw.avg_rating) : null },
      clients_new: Number(newCl.n),
      masters_active: Number(mast.n),
    });
  } catch (e) { console.error('[manager/kpi]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
