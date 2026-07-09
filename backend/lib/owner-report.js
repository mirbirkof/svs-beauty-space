// Повний фінансово-операційний звіт власнику (для ранкового дайджесту І для
// меню власника в боті). Усе scoped по tenant_id (SaaS). Кожна метрика — окремий
// guard-запит: якщо одна впаде, звіт усе одно збереться. Часовий пояс — Europe/Kiev.
const { getPool } = require('../db-pg');

const TZ = 'Europe/Kiev';
function money(n) { const v = Math.round(Number(n) || 0); return v.toLocaleString('uk-UA').replace(/ /g, ' ') + ' грн'; }
function pctBar(p) { return p >= 100 ? '✅' : p >= 80 ? '🟢' : p >= 50 ? '🟡' : '🔴'; }

// одиночний рядок або {} при помилці
async function one(pool, sql, params) {
  try { return (await pool.query(sql, params)).rows[0] || {}; } catch (_) { return {}; }
}
async function many(pool, sql, params) {
  try { return (await pool.query(sql, params)).rows || []; } catch (_) { return []; }
}

// Головний збирач. date = 'YYYY-MM-DD' (київський день), за замовч. — сьогодні.
async function buildDailyReport(pool, tenantId, date = null) {
  pool = pool || getPool();
  const d = date; // null → беремо CURRENT_DATE в київ TZ у запитах
  const dExpr = d ? '$2::date' : `(NOW() AT TIME ZONE '${TZ}')::date`;
  const p = d ? [tenantId, d] : [tenantId];

  // 1) Каса дня: послуги/товари, нал/безнал, чеки
  const cash = await one(pool,
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE category='sale_service'),0)::numeric svc,
       COALESCE(SUM(amount) FILTER (WHERE category='sale_product'),0)::numeric prod,
       COALESCE(SUM(amount) FILTER (WHERE method='cash'),0)::numeric cash,
       COALESCE(SUM(amount) FILTER (WHERE method<>'cash'),0)::numeric cashless,
       COUNT(*)::int checks
     FROM cash_operations
     WHERE tenant_id=$1 AND type='in' AND category IN ('sale_service','sale_product')
       AND (created_at AT TIME ZONE '${TZ}')::date = ${dExpr}`, p);
  const revenue = Number(cash.svc || 0) + Number(cash.prod || 0);

  // 2) Витрати дня
  const outRow = await one(pool,
    `SELECT COALESCE(SUM(amount),0)::numeric v FROM cash_operations
      WHERE tenant_id=$1 AND type='out' AND (created_at AT TIME ZONE '${TZ}')::date = ${dExpr}`, p);
  const expenses = Number(outRow.v || 0);

  // 3) Залишок грошей (весь час: прихід − витрати)
  const balRow = await one(pool,
    `SELECT (COALESCE(SUM(amount) FILTER (WHERE type='in'),0)
            -COALESCE(SUM(amount) FILTER (WHERE type='out'),0))::numeric v
       FROM cash_operations WHERE tenant_id=$1`, [tenantId]);
  const balance = Number(balRow.v || 0);

  // 4) Клієнти дня: усього / нові / повторні / no-show
  const cl = await one(pool,
    `SELECT
       COUNT(DISTINCT a.client_id) FILTER (WHERE a.status IN ('done','confirmed'))::int total,
       COUNT(DISTINCT a.client_id) FILTER (WHERE a.status IN ('done','confirmed')
         AND (c.first_visit_at AT TIME ZONE '${TZ}')::date = ${dExpr})::int new,
       COUNT(*) FILTER (WHERE a.status='noshow')::int noshow
     FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
     WHERE a.tenant_id=$1 AND (a.starts_at AT TIME ZONE '${TZ}')::date = ${dExpr}`, p);
  const clTotal = Number(cl.total || 0), clNew = Number(cl.new || 0);
  const clRepeat = Math.max(0, clTotal - clNew);

  // 5) Кращий майстер дня (за виручкою послуг)
  const best = await one(pool,
    `SELECT m.name, COALESCE(SUM(co.amount),0)::numeric v
       FROM cash_operations co JOIN masters m ON m.id=co.master_id
      WHERE co.tenant_id=$1 AND co.type='in' AND co.category='sale_service'
        AND (co.created_at AT TIME ZONE '${TZ}')::date = ${dExpr}
      GROUP BY m.name ORDER BY v DESC LIMIT 1`, p);

  // 6) Місяць: оборот факт проти плану
  const mRow = await one(pool,
    `SELECT COALESCE(SUM(amount),0)::numeric v FROM cash_operations
      WHERE tenant_id=$1 AND type='in' AND category IN ('sale_service','sale_product')
        AND created_at >= date_trunc('month', NOW() AT TIME ZONE '${TZ}')`, [tenantId]);
  const monthRev = Number(mRow.v || 0);
  const planRow = await one(pool,
    `SELECT COALESCE(SUM(CASE WHEN mp.auto_from_shifts THEN mp.plan_per_shift*COALESCE(sh.shifts,0) ELSE mp.plan_total END),0)::numeric v
       FROM master_monthly_plans mp JOIN masters m ON m.id=mp.master_id AND COALESCE(m.active,true)
       LEFT JOIN (SELECT master_id, COUNT(*) shifts FROM master_schedule_days
                   WHERE work_date >= date_trunc('month', CURRENT_DATE) AND start_time IS NOT NULL
                   GROUP BY master_id) sh ON sh.master_id=mp.master_id
      WHERE mp.tenant_id=$1 AND mp.year=EXTRACT(year FROM CURRENT_DATE)::int
        AND mp.month=EXTRACT(month FROM CURRENT_DATE)::int`, [tenantId]);
  const monthPlan = Number(planRow.v || 0);
  const planPct = monthPlan > 0 ? Math.round(monthRev / monthPlan * 100) : null;

  // 7) Завантаженість майстрів сьогодні (зайняті хв / робочі хв за графіком)
  const load = await many(pool,
    `SELECT m.name,
            COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at-a.starts_at))/60) FILTER (WHERE a.status NOT IN ('cancelled','noshow')),0)::int busy_min,
            COALESCE(EXTRACT(EPOCH FROM (MAX(msd.end_time)-MIN(msd.start_time)))/60,0)::int work_min
       FROM masters m
       LEFT JOIN master_schedule_days msd ON msd.master_id=m.id AND msd.work_date = ${d ? '$2::date' : 'CURRENT_DATE'}
       LEFT JOIN appointments a ON a.master_id=m.id AND a.tenant_id=$1
            AND (a.starts_at AT TIME ZONE '${TZ}')::date = ${dExpr}
      WHERE m.tenant_id=$1 AND COALESCE(m.active,true) AND COALESCE(m.provides_services,true)
      GROUP BY m.name HAVING COALESCE(EXTRACT(EPOCH FROM (MAX(msd.end_time)-MIN(msd.start_time)))/60,0) > 0
      ORDER BY m.name`, p);

  // 8) Вільних годин ЗАВТРА (робочі хв − зайняті хв, по всіх майстрах)
  const free = await one(pool,
    `SELECT GREATEST(0, (
        COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (msd.end_time-msd.start_time))/60)
                    FROM master_schedule_days msd JOIN masters m ON m.id=msd.master_id
                   WHERE m.tenant_id=$1 AND COALESCE(m.active,true) AND msd.work_date=CURRENT_DATE+1 AND msd.start_time IS NOT NULL),0)
      - COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (a.ends_at-a.starts_at))/60)
                    FROM appointments a WHERE a.tenant_id=$1 AND a.status NOT IN ('cancelled','noshow')
                     AND (a.starts_at AT TIME ZONE '${TZ}')::date = (CURRENT_DATE+1)),0)
      ))::int min`, [tenantId]);
  const freeTomorrowH = Math.round(Number(free.min || 0) / 60 * 10) / 10;

  // 9) Записи на 7 днів вперед + очікувана виручка
  const fwd = await one(pool,
    `SELECT COUNT(*)::int n, COALESCE(SUM(COALESCE(price,0)),0)::numeric v
       FROM appointments
      WHERE tenant_id=$1 AND status NOT IN ('cancelled','noshow')
        AND starts_at > NOW() AND starts_at <= NOW() + INTERVAL '7 days'`, [tenantId]);

  // 10) Клієнтів повернути (були 2+ рази, зникли 75-180 днів) — на 30 днів роботи
  const winback = await one(pool,
    `SELECT COUNT(*)::int n FROM clients
      WHERE tenant_id=$1 AND COALESCE(total_visits,0) >= 2 AND deleted_at IS NULL
        AND last_visit_at IS NOT NULL
        AND last_visit_at < NOW() - INTERVAL '75 days' AND last_visit_at > NOW() - INTERVAL '180 days'`, [tenantId]);

  return {
    date: d, revenue, cosmetics: Number(cash.prod || 0), services: Number(cash.svc || 0),
    cash: Number(cash.cash || 0), cashless: Number(cash.cashless || 0), checks: Number(cash.checks || 0),
    expenses, balance, clients: { total: clTotal, new: clNew, repeat: clRepeat, noshow: Number(cl.noshow || 0) },
    bestMaster: best.name ? { name: best.name, revenue: Number(best.v || 0) } : null,
    month: { revenue: monthRev, plan: monthPlan, pct: planPct },
    load, freeTomorrowH, forward: { count: Number(fwd.n || 0), revenue: Number(fwd.v || 0) },
    winback: Number(winback.n || 0),
  };
}

// Форматування у Telegram-HTML (повний звіт)
function formatReport(r, title = 'Щоденний звіт') {
  const L = [];
  L.push(`📊 <b>${title}</b>`);
  L.push('');
  L.push(`💰 <b>Виручка: ${money(r.revenue)}</b> (${r.checks} чек.)`);
  L.push(`   • Послуги ${money(r.services)} · Косметика ${money(r.cosmetics)}`);
  L.push(`   • Готівка ${money(r.cash)} · Безнал ${money(r.cashless)}`);
  if (r.month.pct != null) L.push(`🎯 <b>Місяць:</b> ${money(r.month.revenue)} з ${money(r.month.plan)} (${pctBar(r.month.pct)} <b>${r.month.pct}%</b>)`);
  L.push('');
  L.push(`👥 <b>Клієнти:</b> ${r.clients.total}  (🆕 ${r.clients.new} · 🔁 ${r.clients.repeat})`);
  if (r.bestMaster) L.push(`🏆 <b>Кращий майстер:</b> ${r.bestMaster.name} — ${money(r.bestMaster.revenue)}`);
  L.push(`💸 <b>Витрати:</b> ${money(r.expenses)}`);
  L.push(`🏦 <b>Залишок:</b> ${money(r.balance)}`);
  L.push('');
  if (r.load && r.load.length) {
    L.push(`📈 <b>Завантаженість майстрів:</b>`);
    for (const m of r.load) {
      const pct = m.work_min > 0 ? Math.round(m.busy_min / m.work_min * 100) : 0;
      L.push(`   • ${m.name}: ${pct}%`);
    }
  }
  L.push(`🕓 <b>Вільно завтра:</b> ${r.freeTomorrowH} год`);
  L.push(`📅 <b>Записів на 7 днів:</b> ${r.forward.count} на ${money(r.forward.revenue)} (очікувана виручка)`);
  if (r.winback > 0) L.push(`🔔 <b>Повернути клієнтів:</b> ${r.winback} (зникли 2.5-6 міс, були постійними)`);
  if (r.clients.noshow > 0) L.push(`⚠️ <b>Не прийшли:</b> ${r.clients.noshow}`);
  return L.join('\n');
}

module.exports = { buildDailyReport, formatReport, money };
