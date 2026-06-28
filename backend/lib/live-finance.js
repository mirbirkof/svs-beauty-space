/* lib/live-finance.js — ЄДИНЕ джерело правди по фінансах (accrual / «на цю секунду»).
   Один розрахунок для дашборду, Фінцентру, overview — щоб цифри СКРІЗЬ збігались.
   Витрати = собівартість матеріалів (COGS) + НАРАХОВАНИЙ % майстрам по реальній схемі
             за завершені послуги + фікс-оклади (пропорційно періоду) + інші витрати каси
             (оренда/реклама/закупівлі — БЕЗ касової категорії salary, бо її замінює нарахований %).
   Прибуток = виручка − витрати. Працює для будь-якого періоду [from, to]. */

const CAT_LABELS = {
  rent: 'Оренда', salary: 'Зарплата', payroll: 'Зарплата', purchase: 'Закупівлі', purchasing: 'Закупівлі',
  marketing: 'Маркетинг', utilities: 'Комуналка', supplies: 'Витратні', taxes: 'Податки', other: 'Інше',
  materials: 'Матеріали (собівартість)', commission: 'Зарплата майстрів (нарахована)',
};

async function liveFinance(pool, from, to) {
  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
  const [revC, ordR, comm, fixed, cogs, other] = await Promise.all([
    q(`SELECT COALESCE(SUM(amount) FILTER (WHERE category='sale_service'),0)::numeric svc,
              COALESCE(SUM(amount) FILTER (WHERE category='sale_product' AND ref_type IS DISTINCT FROM 'order'),0)::numeric prod,
              COUNT(*) FILTER (WHERE category IN ('sale_service','sale_product'))::int cnt
         FROM cash_operations WHERE type='in' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT COALESCE(SUM(total),0)::numeric s, COUNT(*)::int c FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`WITH da AS (
         SELECT a.master_id, COALESCE(a.real_amount,a.price,0) rev FROM appointments a
          WHERE a.starts_at BETWEEN $1 AND $2
            AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL)))
       SELECT COALESCE(SUM(CASE WHEN ps.scheme_type IN ('percent','hybrid') THEN da.rev*COALESCE(ps.percent,0)/100 ELSE 0 END),0)::numeric comm,
              COUNT(*)::int appts
         FROM da LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE`, [from, to]),
    q(`SELECT COALESCE(SUM(COALESCE(fixed_per_month,0)),0)::numeric fx
         FROM payroll_schemes ps JOIN masters m ON m.id::text=ps.master_id
        WHERE ps.is_active=TRUE AND ps.scheme_type IN ('fixed','hybrid') AND m.active=TRUE`),
    q(`SELECT COALESCE(SUM(ABS(sm.delta)*COALESCE(pv.wholesale,0)),0)::numeric g
         FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id
        WHERE (sm.reason IN ('sale','order') OR sm.reason LIKE 'order:%') AND sm.delta<0
          AND sm.created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT category, COALESCE(SUM(amount),0)::numeric s FROM cash_operations
        WHERE type='out' AND category NOT IN ('salary','payroll') AND created_at BETWEEN $1 AND $2
        GROUP BY category ORDER BY s DESC`, [from, to]),
  ]);

  const revServices = Number(revC[0]?.svc || 0);
  const revProducts = Number(revC[0]?.prod || 0) + Number(ordR[0]?.s || 0);
  const revTotal = revServices + revProducts;

  const commissionPct = Number(comm[0]?.comm || 0);
  const fixedAccrued = Number(fixed[0]?.fx || 0) * (days / 30); // оклади — пропорційно довжині періоду
  const commission = Math.round(commissionPct + fixedAccrued);
  const materials = Math.round(Number(cogs[0]?.g || 0));
  const otherCats = other.map(r => ({ category: r.category, label: CAT_LABELS[r.category] || r.category, sum: Math.round(Number(r.s)) }));
  const otherTotal = otherCats.reduce((a, r) => a + r.sum, 0);
  const expTotal = commission + materials + otherTotal;

  const by_category = [
    { category: 'materials', label: CAT_LABELS.materials, sum: materials },
    { category: 'commission', label: CAT_LABELS.commission, sum: commission },
    ...otherCats,
  ].filter(x => x.sum > 0).sort((a, b) => b.sum - a.sum);

  const txCount = Number(revC[0]?.cnt || 0) + Number(ordR[0]?.c || 0);
  const netProfit = revTotal - expTotal;
  return {
    revenue: { services: revServices, products: revProducts, total: revTotal },
    expenses: { by_category, total: expTotal, materials, commission, other: otherCats },
    profit: { net: netProfit, margin_pct: revTotal > 0 ? Math.round(netProfit / revTotal * 100) : 0 },
    tx_count: txCount,
    avg_check: txCount > 0 ? Math.round(revTotal / txCount) : 0,
    commission_appts: Number(comm[0]?.appts || 0),
  };
}

module.exports = { liveFinance, CAT_LABELS };
