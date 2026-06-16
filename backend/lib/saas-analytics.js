/* lib/saas-analytics.js — SaaS-метрики (SAS-07): MRR/ARR/ARPU/churn/LTV, воронка, когорти.
   Контрольна площина SaaS (cross-tenant): tenants + tenant_licenses + saas_plans.
   MRR рахується по активних ліцензіях × місячна ціна плану (річні плани → /12 нема ознаки
   циклу в схемі, тому беремо price_month). Підписки рахуються як monthly. */
const { getPool } = require('../db-pg');

const ACTIVE = ['active', 'trialing', 'trial', 'past_due'];
const PAYING = ['active', 'past_due'];

// Базові метрики доходу.
async function metrics() {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT l.tenant_id, l.plan_code, l.status,
            COALESCE(p.price_month,0)::float AS price_month
       FROM tenant_licenses l
       LEFT JOIN saas_plans p ON p.code = l.plan_code`)).rows;

  let mrr = 0, payingCount = 0;
  const byStatus = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (PAYING.includes(r.status) && r.price_month > 0) { mrr += r.price_month; payingCount++; }
  }
  const arr = mrr * 12;
  const arpu = payingCount ? Math.round((mrr / payingCount) * 100) / 100 : 0;
  const activeCount = rows.filter(r => ACTIVE.includes(r.status)).length;

  return {
    mrr: Math.round(mrr * 100) / 100, arr: Math.round(arr * 100) / 100,
    arpu, paying_tenants: payingCount, active_tenants: activeCount,
    total_licenses: rows.length, by_status: byStatus,
  };
}

// Воронка життєвого циклу: реєстрації → тріал → платні.
async function funnel() {
  const pool = getPool();
  const signups = (await pool.query(`SELECT COUNT(*)::int n FROM tenants`)).rows[0].n;
  const lic = (await pool.query(`SELECT status, trial_ends_at FROM tenant_licenses`)).rows;
  const trial = lic.filter(l => ['trial', 'trialing'].includes(l.status) || l.trial_ends_at).length;
  const paid = lic.filter(l => PAYING.includes(l.status)).length;
  return {
    signups, trial, paid,
    signup_to_trial: signups ? Math.round((trial / signups) * 1000) / 10 : 0,
    trial_to_paid: trial ? Math.round((paid / trial) * 1000) / 10 : 0,
    signup_to_paid: signups ? Math.round((paid / signups) * 1000) / 10 : 0,
  };
}

// Помісячний рух: нові / відток / нетто за N місяців.
async function churn({ months = 12 } = {}) {
  const pool = getPool();
  const m = Math.min(Math.max(parseInt(months, 10) || 12, 1), 36);
  const news = (await pool.query(
    `SELECT to_char(date_trunc('month', started_at),'YYYY-MM') ym, COUNT(*)::int n
       FROM tenant_licenses
      WHERE started_at >= (date_trunc('month', NOW()) - ($1 || ' months')::interval)
      GROUP BY 1`, [m])).rows;
  const churned = (await pool.query(
    `SELECT to_char(date_trunc('month', COALESCE(expires_at, updated_at)),'YYYY-MM') ym, COUNT(*)::int n
       FROM tenant_licenses
      WHERE status IN ('cancelled','canceled','expired','churned')
        AND COALESCE(expires_at, updated_at) >= (date_trunc('month', NOW()) - ($1 || ' months')::interval)
      GROUP BY 1`, [m])).rows;
  const newMap = Object.fromEntries(news.map(r => [r.ym, r.n]));
  const chMap = Object.fromEntries(churned.map(r => [r.ym, r.n]));
  const series = [];
  for (let i = m - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const ym = d.toISOString().slice(0, 7);
    const n = newMap[ym] || 0, c = chMap[ym] || 0;
    series.push({ month: ym, new: n, churned: c, net: n - c });
  }
  const totalActive = (await pool.query(
    `SELECT COUNT(*)::int n FROM tenant_licenses WHERE status IN ('active','past_due')`)).rows[0].n;
  const lastChurn = series.length ? series[series.length - 1].churned : 0;
  const churnRate = totalActive ? Math.round((lastChurn / totalActive) * 1000) / 10 : 0;
  return { months: m, series, current_active: totalActive, monthly_churn_rate: churnRate };
}

// Когортна утримуваність: тенанти по місяцю реєстрації, скільки досі активні.
async function cohorts() {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT to_char(date_trunc('month', t.created_at),'YYYY-MM') cohort,
            COUNT(*)::int signed_up,
            COUNT(*) FILTER (WHERE l.status IN ('active','past_due','trial','trialing'))::int still_active
       FROM tenants t
       LEFT JOIN tenant_licenses l ON l.tenant_id = t.id
      GROUP BY 1 ORDER BY 1`)).rows;
  return rows.map(r => ({
    ...r, retention_pct: r.signed_up ? Math.round((r.still_active / r.signed_up) * 1000) / 10 : 0,
  }));
}

// LTV ≈ ARPU / місячний churn (грубо). Якщо churn=0 — повертаємо null (нескінченність).
async function ltv() {
  const m = await metrics();
  const c = await churn({ months: 6 });
  const rate = c.monthly_churn_rate / 100;
  const ltvVal = rate > 0 ? Math.round((m.arpu / rate) * 100) / 100 : null;
  const lifetimeMonths = rate > 0 ? Math.round(1 / rate) : null;
  return { arpu: m.arpu, monthly_churn_rate: c.monthly_churn_rate, ltv: ltvVal, avg_lifetime_months: lifetimeMonths };
}

async function overview() {
  const [m, f, c, co, l] = await Promise.all([metrics(), funnel(), churn({ months: 12 }), cohorts(), ltv()]);
  return { metrics: m, funnel: f, churn: c, cohorts: co, ltv: l, generated_at: new Date().toISOString() };
}

module.exports = { metrics, funnel, churn, cohorts, ltv, overview };
