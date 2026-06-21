/* lib/saas-analytics.js — SaaS-метрики (SAS-07): MRR/ARR/ARPU/churn/LTV, воронка, когорти.
   Контрольна площина SaaS (cross-tenant): tenants + subscriptions_saas + payments_saas + saas_plans.

   ПРАВИЛО ДОХОДУ (узгоджено з власником, заметки #56/#57):
   - Дохід рахується ЛИШЕ з моменту, коли оплата реально пройшла (payments_saas.status='succeeded').
   - MRR = місячний еквівалент підписок, які РЕАЛЬНО платять: підписка active + має успішну
     оплату + тенант НЕ внутрішній (is_internal=false). Тріал у MRR не входить (це безкоштовний період).
   - Річний цикл → price_year/12 (а не price_month), бо платять за рік наперед.
   - Внутрішні тенанти (власний салон оператора + тестові) виключені — інакше виручка «надувається».
   - collected_total / collected_30d = фактично отримані гроші (сума успішних оплат). */
const { getPool } = require('../db-pg');

// Підписки, що формують виручку: active або прострочена (була платною). Тріал — ні.
const PAYING_SUB = ['active', 'past_due'];

// Базові метрики доходу. Джерело істини — реальні оплати, а не статус ліцензії.
async function metrics() {
  const pool = getPool();
  // Платні підписки: НЕ внутрішній тенант + active/past_due + є хоч одна успішна оплата.
  const rows = (await pool.query(
    `SELECT s.tenant_id, s.plan_code, s.status, s.billing_cycle,
            COALESCE(p.price_month,0)::float AS price_month,
            COALESCE(p.price_year,0)::float  AS price_year
       FROM subscriptions_saas s
       JOIN tenants t      ON t.id = s.tenant_id AND t.is_internal = FALSE
       LEFT JOIN saas_plans p ON p.code = s.plan_code
      WHERE s.status = ANY($1)
        AND EXISTS (SELECT 1 FROM payments_saas pay
                     WHERE pay.tenant_id = s.tenant_id AND pay.status = 'succeeded')`,
    [PAYING_SUB])).rows;

  let mrr = 0, payingCount = 0;
  for (const r of rows) {
    const monthly = r.billing_cycle === 'yearly'
      ? (r.price_year > 0 ? r.price_year / 12 : 0)
      : r.price_month;
    if (monthly > 0) { mrr += monthly; payingCount++; }
  }
  const arr = mrr * 12;
  const arpu = payingCount ? Math.round((mrr / payingCount) * 100) / 100 : 0;

  // Фактично отримані гроші (виключаючи внутрішні тенанти).
  const collected = (await pool.query(
    `SELECT COALESCE(SUM(pay.amount),0)::float total,
            COALESCE(SUM(pay.amount) FILTER (WHERE pay.created_at >= NOW()-INTERVAL '30 days'),0)::float d30
       FROM payments_saas pay
       JOIN tenants t ON t.id = pay.tenant_id AND t.is_internal = FALSE
      WHERE pay.status = 'succeeded'`)).rows[0];

  // Активні підписки (вкл. тріал) серед справжніх клієнтів — для контексту.
  const counts = (await pool.query(
    `SELECT s.status, COUNT(*)::int n
       FROM subscriptions_saas s
       JOIN tenants t ON t.id = s.tenant_id AND t.is_internal = FALSE
      GROUP BY s.status`)).rows;
  const byStatus = {}; counts.forEach(r => byStatus[r.status] = r.n);
  const activeCount = (byStatus.active || 0) + (byStatus.trialing || 0) + (byStatus.past_due || 0);

  return {
    mrr: Math.round(mrr * 100) / 100, arr: Math.round(arr * 100) / 100,
    arpu, paying_tenants: payingCount, active_tenants: activeCount,
    collected_total: Math.round(collected.total * 100) / 100,
    collected_30d: Math.round(collected.d30 * 100) / 100,
    total_licenses: payingCount, by_status: byStatus,
  };
}

// Воронка життєвого циклу: реєстрації → тріал → платні.
async function funnel() {
  const pool = getPool();
  // Лише справжні клієнти (внутрішні/тестові тенанти не рахуються).
  const signups = (await pool.query(`SELECT COUNT(*)::int n FROM tenants WHERE is_internal = FALSE`)).rows[0].n;
  const lic = (await pool.query(
    `SELECT s.status, s.trial_ends_at,
            EXISTS (SELECT 1 FROM payments_saas pay WHERE pay.tenant_id=s.tenant_id AND pay.status='succeeded') AS has_paid
       FROM subscriptions_saas s
       JOIN tenants t ON t.id = s.tenant_id AND t.is_internal = FALSE`)).rows;
  const trial = lic.filter(l => ['trial', 'trialing'].includes(l.status) || l.trial_ends_at).length;
  // Платний = active/past_due І є реальна оплата.
  const paid = lic.filter(l => PAYING_SUB.includes(l.status) && l.has_paid).length;
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
    `SELECT to_char(date_trunc('month', l.started_at),'YYYY-MM') ym, COUNT(*)::int n
       FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id
      WHERE t.is_internal = FALSE
        AND l.started_at >= (date_trunc('month', NOW()) - ($1 || ' months')::interval)
      GROUP BY 1`, [m])).rows;
  const churned = (await pool.query(
    `SELECT to_char(date_trunc('month', COALESCE(l.expires_at, l.updated_at)),'YYYY-MM') ym, COUNT(*)::int n
       FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id
      WHERE t.is_internal = FALSE
        AND l.status IN ('cancelled','canceled','expired','churned')
        AND COALESCE(l.expires_at, l.updated_at) >= (date_trunc('month', NOW()) - ($1 || ' months')::interval)
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
    `SELECT COUNT(*)::int n FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id
      WHERE t.is_internal = FALSE AND l.status IN ('active','past_due')`)).rows[0].n;
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
      WHERE t.is_internal = FALSE
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
