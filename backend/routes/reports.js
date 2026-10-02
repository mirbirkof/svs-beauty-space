/* Reports: P&L, KPI мастеров, RFM-сегментация, отток
   Все эндпоинты требуют reports.read */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, hasPermission } = require('../lib/rbac');
const { shiftDaysByMaster, shiftStatsByMasterInRange } = require('../lib/schedule-month');
const { CHURNED_CTE, CHURN_COUNT_SQL } = require('../lib/churn');
const { MATLINES_CTE, COMMISSION_EXPR, SVCPCT_CTE } = require('../lib/payroll-base');
// 27.07: % майстра — тільки по операційних візитах (див. коментар у financial.js)
const { payrollEligibleExpr } = require('../lib/settlement');
const { cacheReport } = require('../lib/report-cache');
const { liveFinance } = require('../lib/live-finance');

const router = express.Router();
const pool = getPool();

// Смещение часового пояса Киева для конкретной даты (учитывает летнее/зимнее время)
function kyivOffsetMin(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kiev',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
// 'YYYY-MM-DD' → UTC-инстант начала/конца этого дня по Киеву.
// Это убирает сдвиг на сутки: клик по «13 червня» больше не тянет данные за 12-е.
function kyivDayBound(dateStr, isEnd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m-1, d, isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
  const off = kyivOffsetMin(new Date(naive));
  return new Date(naive - off*60000);
}

function parsePeriod(q) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  let end, start;
  if (q.to && dateRe.test(q.to)) end = kyivDayBound(q.to, true);
  else end = q.to ? new Date(q.to) : new Date();
  if (q.from && dateRe.test(q.from)) start = kyivDayBound(q.from, false);
  else start = q.from ? new Date(q.from) : new Date(end.getTime() - 30*86400*1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

// ── P&L (Profit & Loss) ─────────────────────────────────
// GET /api/reports/pnl?from=&to=
router.get('/pnl', requirePerm('reports.finance'), cacheReport(), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);

    // Доход — товары: заказы магазина (orders) + продажи товаров в салоне (cash_operations sale_product)
    const revOrders = await pool.query(
      `SELECT COALESCE(SUM(total),0)::numeric AS rev, COUNT(*)::int AS cnt
         FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    );
    const revProductsSalon = await pool.query(
      // ref_type IS DISTINCT FROM 'order' — не двоїмо товари: касова продаж із ref_type='order'
      // це та сама онлайн-покупка, що вже врахована в orders(paid) вище (як у liveFinance/pnl).
      `SELECT COALESCE(SUM(amount),0)::numeric AS rev, COUNT(*)::int AS cnt
         FROM cash_operations WHERE type='in' AND category='sale_product'
           AND ref_type IS DISTINCT FROM 'order' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    );
    // Доход — услуги: из кассы (sale_service)
    const revServices = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS rev, COUNT(*)::int AS cnt
         FROM cash_operations WHERE type='in' AND category='sale_service' AND created_at BETWEEN $1 AND $2`,
      [from, to]
    );

    // COGS (себестоимость проданных товаров) — расходные движения по заказам × оптовая цена варианта
    const cogs = await pool.query(
      `SELECT COALESCE(SUM(ABS(sm.delta) * COALESCE(pv.wholesale,0)),0)::numeric AS cogs
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id = sm.variant_id
        WHERE sm.reason LIKE 'order:%' AND sm.delta < 0
          AND sm.created_at BETWEEN $1 AND $2`,
      [from, to]
    ).catch((e) => { console.error('[reports] COGS запит впав — собівартість НЕ врахована:', e.message); return { rows: [{ cogs: 0, _failed: true }] }; });

    // Расходы по категориям из cash
    const exp = await pool.query(
      `SELECT category, COALESCE(SUM(amount),0)::numeric AS sum, COUNT(*)::int AS cnt
         FROM cash_operations WHERE type='out' AND created_at BETWEEN $1 AND $2
        GROUP BY category ORDER BY sum DESC`,
      [from, to]
    );

    // ЄДИНЕ джерело правди (lib/live-finance) — щоб P&L збігався з Дашбордом і Фінцентром.
    const fin = await liveFinance(pool, from, to);
    const revenueTotal = fin.revenue.total;
    const cogsTotal    = fin.expenses.materials;                 // собівартість матеріалів = COGS
    const grossProfit  = revenueTotal - cogsTotal;
    const expRows      = fin.expenses.by_category.filter(x => x.category !== 'materials'); // % майстрам + оренда + інше
    const expenseTotal = fin.expenses.total - cogsTotal;
    const netProfit    = revenueTotal - fin.expenses.total;

    res.json({
      period: { from, to },
      revenue: { products: fin.revenue.products, services: fin.revenue.services, total: revenueTotal },
      cogs: cogsTotal,
      gross_profit: grossProfit,
      gross_margin_pct: revenueTotal > 0 ? Math.round(grossProfit / revenueTotal * 100) : 0,
      expenses: expRows.map(x => ({ category: x.category, label: x.label, sum: x.sum })),
      expense_total: expenseTotal,
      net_profit: netProfit,
      net_margin_pct: revenueTotal > 0 ? Math.round(netProfit / revenueTotal * 100) : 0,
      counts: { orders: revOrders.rows[0].cnt, service_ops: revServices.rows[0].cnt }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── KPI мастеров ────────────────────────────────────────
// GET /api/reports/masters?from=&to=
router.get('/masters', requirePerm('reports.finance'), cacheReport(), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);

    const r = await pool.query(
      // Виручку беремо з КАСИ (cash_operations), а НЕ з appointments.price WHERE done —
      // стара CRM лишає візити у статусі 'confirmed', тому 'done'-сума недораховує виручку вдвічі.
      // done_appts (для середнього чека і % відмін) = реально проведені візити: не скасовані/неявки і вже в минулому.
      `WITH appts AS (
         SELECT master_id,
                -- % відмін: технічні стани синхронізації стара CRM (bp_deleted — видалені,
                -- not_in_bukon — не знайдені в журналі й скасовані автоматом, phantom_dup —
                -- дублі) НЕ є відмовами клієнтів. Рахуємо їх ні в чисельнику, ні в знаменнику
                -- (аудит 25.07: інакше «30.9%» відмін замість чесних 11.5%).
                COUNT(*) FILTER (WHERE COALESCE(legacy_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup'))::int AS total_appts,
                -- візит = клієнт + день, а не рядок: інакше один прихід з трьома послугами
                -- ділив виручку мастера на три і занижував його середній чек (аудит 25.07)
                COUNT(DISTINCT (COALESCE(client_id::text, 'anon-'||id),
                                (starts_at AT TIME ZONE 'Europe/Kyiv')::date))
                  FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int AS done_appts,
                COUNT(*) FILTER (WHERE status='cancelled' AND COALESCE(legacy_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup'))::int AS canceled_appts,
                COUNT(*) FILTER (WHERE status='noshow' AND COALESCE(legacy_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup'))::int    AS no_show_appts,
                COUNT(DISTINCT client_id)::int   AS unique_clients
           FROM appointments
          WHERE starts_at BETWEEN $1 AND $2
          GROUP BY master_id
       ),
       cash AS (
         SELECT master_id, COALESCE(SUM(amount),0)::numeric AS revenue
           FROM cash_operations
          WHERE type='in' AND category IN ('sale_service','sale_product')
            AND created_at BETWEEN $1 AND $2 AND master_id IS NOT NULL
          GROUP BY master_id
       ),
       payroll AS (
         SELECT master_id::int AS master_id, COALESCE(SUM(total),0)::numeric AS payroll_sum
           FROM payroll_records
          WHERE period_start >= $1::date AND period_end <= $2::date
            -- \\d, а не \d: це JS-шаблонний рядок, одинарний \d перетворювався на 'd',
            -- фільтр не збігався ніколи і фактичні виплати ігнорувались (аудит 25.07)
            AND master_id ~ '^\\d+$'
          GROUP BY master_id::int
       ),
       -- НАРАХОВАНА ЗП (виручка × % схеми) за період — щоб колонка ЗП не була 0 до дня виплати
       matlines AS (${MATLINES_CTE}),
       svcpct AS (${SVCPCT_CTE}),
       accrued AS (
         SELECT da.master_id,
                ROUND(SUM(${COMMISSION_EXPR('da.rev_labor','da.rev_full', { sp: 'sp' })})) AS accrued_sum
           FROM (SELECT a.master_id, a.id aid,
                        GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0)) rev_labor,
                        COALESCE(a.real_amount,a.price,0) rev_full
                   FROM appointments a LEFT JOIN matlines ml ON ml.aid=a.id
                  WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
                    AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
                    AND ${payrollEligibleExpr('a')}) da
           LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE
           LEFT JOIN svcpct sp ON sp.aid=da.aid
          GROUP BY da.master_id
       )
       SELECT m.id, m.name,
              a.total_appts, a.done_appts, a.canceled_appts, a.no_show_appts,
              a.unique_clients, COALESCE(ca.revenue,0)::numeric AS revenue,
              COALESCE(NULLIF(p.payroll_sum,0), acc.accrued_sum, 0) AS payroll_sum,
              CASE WHEN a.done_appts > 0
                   THEN ROUND(COALESCE(ca.revenue,0) / a.done_appts, 2)
                   ELSE 0 END AS avg_ticket,
              CASE WHEN a.total_appts > 0
                   THEN ROUND(a.canceled_appts::numeric / a.total_appts * 100, 1)
                   ELSE 0 END AS cancel_rate_pct
         FROM masters m
         LEFT JOIN appts a   ON a.master_id = m.id
         LEFT JOIN cash ca   ON ca.master_id = m.id
         LEFT JOIN payroll p ON p.master_id = m.id
         LEFT JOIN accrued acc ON acc.master_id = m.id
         WHERE a.total_appts > 0 OR p.payroll_sum > 0 OR ca.revenue > 0
         ORDER BY revenue DESC NULLS LAST`,
      [from, to]
    );

    res.json({ period: { from, to }, items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── RFM-сегментация клиентов ────────────────────────────
// Recency / Frequency / Monetary, скор 1-5 по каждой оси
// GET /api/reports/rfm
router.get('/rfm', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `-- Роздільна агрегація orders та appointments (без декартового добутку:
       -- раніше подвійний LEFT JOIN множив рядки, сума й частота роздувались
       -- у клієнтів, що мали і замовлення, і візити одночасно.
       WITH ord AS (
         SELECT client_id,
                MAX(created_at) FILTER (WHERE status='paid') AS last_paid,
                COUNT(*) FILTER (WHERE status='paid') AS cnt,
                COALESCE(SUM(total) FILTER (WHERE status='paid'),0) AS sm
           FROM orders GROUP BY client_id
       ),
       ap AS (
         SELECT a.client_id,
                MAX(a.starts_at) FILTER (WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW()) AS last_visit,
                -- ВІЗИТИ, а не рядки: один прихід з трьома послугами = три рядки appointments.
                -- Через це частота була завищена на 269 «фантомних візитів» (аудит 25.07)
                COUNT(DISTINCT (a.starts_at AT TIME ZONE 'Europe/Kiev')::date)
                  FILTER (WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW()) AS cnt,
                COALESCE(SUM(COALESCE((SELECT SUM(co.amount) FROM cash_operations co
                                        WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=a.id),
                                      COALESCE(a.real_amount, a.price)))
                         FILTER (WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW()),0) AS sm
           FROM appointments a GROUP BY a.client_id
       ),
       base AS (
         SELECT c.id, c.name, c.phone,
                GREATEST(ord.last_paid, ap.last_visit) AS last_activity,
                COALESCE(ord.cnt,0) + COALESCE(ap.cnt,0) AS frequency,
                COALESCE(ord.sm,0)  + COALESCE(ap.sm,0)  AS monetary
           FROM clients c
           LEFT JOIN ord ON ord.client_id = c.id
           LEFT JOIN ap  ON ap.client_id  = c.id
       ),
       filtered AS (
         SELECT * FROM base WHERE last_activity IS NOT NULL
       ),
       scored AS (
         SELECT id, name, phone, last_activity, frequency, monetary,
                EXTRACT(EPOCH FROM (NOW()-last_activity))/86400 AS recency_days,
                NTILE(5) OVER (ORDER BY last_activity ASC)  AS r_score,
                NTILE(5) OVER (ORDER BY frequency ASC)      AS f_score,
                NTILE(5) OVER (ORDER BY monetary ASC)       AS m_score
           FROM filtered
       )
       SELECT id, name, phone,
              ROUND(recency_days)::int AS recency_days,
              frequency, monetary,
              r_score, f_score, m_score,
              -- Сегменти за РЕАЛЬНИМИ днями і візитами (абсолютні пороги),
              -- а не за відносними процентилями NTILE — інакше клієнт, що був 2 тижні
              -- тому, міг потрапити в «під загрозою» лише тому, що інші приходили вчора.
              CASE
                WHEN frequency >= 4 AND recency_days <= 45  THEN 'champion'  -- часто + недавно
                WHEN frequency >= 2 AND recency_days <= 75  THEN 'loyal'     -- повторні, активні
                WHEN frequency = 1 AND recency_days <= 45   THEN 'new'       -- перший візит недавно
                WHEN frequency >= 2 AND recency_days <= 180  THEN 'at_risk'  -- були постійними, зникають
                WHEN recency_days > 180                      THEN 'lost'     -- понад пів року немає
                ELSE 'regular'                                               -- разовий, давненько
              END AS segment
         FROM scored
         ORDER BY monetary DESC
         LIMIT 6000`
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Отток (churn) ───────────────────────────────────────
// Клиенты которые посещали раньше, но не приходили >90 дней
// GET /api/reports/churn?days=90
router.get('/churn', requirePerm('reports.read'), async (req, res) => {
  try {
    // Единое cadence-aware определение (lib/churn.js) — те же клиенты, что в дашборде и у AI.
    const r = await pool.query(
      `${CHURNED_CTE}
       SELECT id, name, phone, last_visit, visits AS total_visits,
              (NOW()::date - last_visit::date) AS days_since
         FROM churned
        ORDER BY last_visit ASC
        LIMIT 500`
    );
    res.json({ definition: 'cadence-aware', items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Сводный дашборд (одним запросом) ────────────────────
// GET /api/reports/dashboard
// Дашборд видит любой с reports.read (домашняя страница админа).
// Месячную выручку и общую фин.статистику отдаём ТОЛЬКО при reports.finance.
router.get('/dashboard', requirePerm('reports.read'), cacheReport(), async (req, res) => {
  try {
    const canFinance = hasPermission(req.user.permissions, 'reports.finance');

    // ВЫРУЧКА = касса салона (услуги+товары) + оплаченные online-заказы.
    // Раньше брали только orders → у салона без интернет-магазина было 0.
    // Все границы считаем по киевскому wall-time, касса/заказы хранятся в UTC.
    const main = await pool.query(`
      WITH b AS (
        SELECT date_trunc('day',   now() AT TIME ZONE 'Europe/Kyiv')                        AS d0,
               date_trunc('day',   now() AT TIME ZONE 'Europe/Kyiv') + INTERVAL '1 day'      AS d1,
               date_trunc('day',   now() AT TIME ZONE 'Europe/Kyiv') - INTERVAL '1 day'      AS yd0,
               date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')                         AS m0,
               date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv') + INTERVAL '1 month'    AS m1,
               date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv') - INTERVAL '1 month'    AS pm0
      ),
      co AS (
        SELECT (created_at AT TIME ZONE 'Europe/Kyiv') AS k, amount, category
          FROM cash_operations
         WHERE type='in' AND category IN ('sale_service','sale_product')
           AND ref_type IS DISTINCT FROM 'order' -- онлайн-замовлення рахуємо з orders, інакше двоїлось (аудит 06.07)
      ),
      ord AS (
        SELECT (created_at AT TIME ZONE 'Europe/Kyiv') AS k, total
          FROM orders WHERE status='paid'
      ),
      ap AS (
        SELECT id, (starts_at AT TIME ZONE 'Europe/Kyiv') AS k, status, client_id
          FROM appointments
      )
      SELECT
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.k>=b.d0 AND co.k<b.d1)
          + (SELECT COALESCE(SUM(total),0) FROM ord,b WHERE ord.k>=b.d0 AND ord.k<b.d1)   AS revenue_today,
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.k>=b.yd0 AND co.k<b.d0)
          + (SELECT COALESCE(SUM(total),0) FROM ord,b WHERE ord.k>=b.yd0 AND ord.k<b.d0)  AS revenue_yesterday,
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.k>=b.m0 AND co.k<b.m1)
          + (SELECT COALESCE(SUM(total),0) FROM ord,b WHERE ord.k>=b.m0 AND ord.k<b.m1)   AS revenue_month,
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.k>=b.pm0 AND co.k<b.m0)
          + (SELECT COALESCE(SUM(total),0) FROM ord,b WHERE ord.k>=b.pm0 AND ord.k<b.m0)  AS revenue_prev_month,
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.category='sale_service' AND co.k>=b.m0 AND co.k<b.m1) AS services_month,
        (SELECT COALESCE(SUM(amount),0) FROM co,b WHERE co.category='sale_product' AND co.k>=b.m0 AND co.k<b.m1) AS products_month,
        (SELECT COUNT(*)            FROM ap,b WHERE ap.k>=b.d0 AND ap.k<b.d1 AND ap.status NOT IN ('cancelled','noshow'))  AS appts_today,
        (SELECT COUNT(*)            FROM ap,b WHERE ap.k>=b.m0 AND ap.k<b.m1 AND ap.status NOT IN ('cancelled','noshow'))  AS appts_month,
        -- Аудит 25.07: середній чек ділили на КІЛЬКІСТЬ РЯДКІВ записів (одна людина з трьома
        -- послугами = три «візити») → чек занижений на третину. Знаменник = реальні візити:
        -- унікальна пара «клієнт + день», і тільки ті, що вже відбулись.
        (SELECT COUNT(DISTINCT (COALESCE(ap.client_id::text, 'anon-'||ap.id), ap.k::date)) FROM ap,b
          WHERE ap.k>=b.m0 AND ap.k<b.m1 AND ap.k <= (NOW() AT TIME ZONE 'Europe/Kyiv')
            AND ap.status NOT IN ('cancelled','noshow'))                                   AS visits_month,
        (SELECT COUNT(DISTINCT client_id) FROM ap,b WHERE ap.k>=b.m0 AND ap.k<b.m1 AND ap.status NOT IN ('cancelled','noshow')) AS clients_month
    `);
    const r0 = main.rows[0] || {}; // порожній тенант: захист від undefined (SaaS-аудит)

    const [lowStock, openShifts, churnCnt, activeMasters, topMaster] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM product_variants WHERE active = true AND COALESCE(stock_qty,0) <= 5`).catch(()=>({rows:[{n:0}]})),
      pool.query(`SELECT COUNT(*)::int AS n FROM cash_shifts WHERE status='open'`).catch(()=>({rows:[{n:0}]})),
      pool.query(CHURN_COUNT_SQL).catch(()=>({rows:[{n:0}]})),
      pool.query(`SELECT COUNT(*)::int AS n FROM masters WHERE active=true`).catch(()=>({rows:[{n:0}]})),
      pool.query(`SELECT m.name, SUM(co.amount)::numeric AS rev
         FROM cash_operations co JOIN masters m ON m.id=co.master_id
        WHERE co.type='in' AND co.category IN ('sale_service','sale_product')
          AND (co.created_at AT TIME ZONE 'Europe/Kyiv') >= date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')
        GROUP BY m.name ORDER BY rev DESC LIMIT 1`).catch(()=>({rows:[]})),
    ]);

    const apptsMonth = Number(r0.appts_month);
    const visitsMonth = Number(r0.visits_month || 0); // реальні візити (клієнт+день), знаменник чека
    const out = {
      revenue_today: Number(r0.revenue_today),
      low_stock_items: lowStock.rows[0].n,
      open_shifts: openShifts.rows[0].n,
      churn_clients: churnCnt.rows[0].n,
      appts_today: Number(r0.appts_today),
      appts_month: apptsMonth,
      clients_month: Number(r0.clients_month),
      active_masters: activeMasters.rows[0].n,
      finance_locked: !canFinance,
    };
    // Финансовые метрики — только владельцу / при reports.finance
    if (canFinance) {
      const revMonth = Number(r0.revenue_month);
      out.revenue_month       = revMonth;
      out.revenue_yesterday   = Number(r0.revenue_yesterday);
      out.revenue_prev_month  = Number(r0.revenue_prev_month);
      out.services_month      = Number(r0.services_month);
      out.products_month      = Number(r0.products_month);
      out.visits_month        = visitsMonth;
      out.avg_check_month     = visitsMonth > 0 ? Math.round(revMonth / visitsMonth) : 0;
      out.top_master          = topMaster.rows[0] ? { name: topMaster.rows[0].name, revenue: Math.round(Number(topMaster.rows[0].rev)) } : null;
    }
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Дневная динамика выручки (для графика) ──────────────
// GET /api/reports/revenue-series?from=&to=
router.get('/revenue-series', requirePerm('reports.finance'), cacheReport(), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const r = await pool.query(
      // Аудит 25.07: вісь днів будувалась як $1::date по UTC, а межа періоду приходить
      // київська (01.07 → 30.06T21:00Z) — графік завжди починався з фальшивого нуля
      // за попередній день. Тепер і вісь, і групування живуть у київському часі.
      `WITH days AS (
         -- кінець періоду приходить як 23:59:59.999 київських, що при округленні залазить
         -- у наступну добу → мінус секунда, інакше в графіку зайвий порожній день у кінці
         SELECT generate_series(($1::timestamptz AT TIME ZONE 'Europe/Kyiv')::date,
                                (($2::timestamptz - interval '1 second') AT TIME ZONE 'Europe/Kyiv')::date,
                                '1 day')::date AS d
       ),
       prod AS (
         SELECT d, SUM(rev)::numeric AS rev FROM (
           SELECT (created_at AT TIME ZONE 'Europe/Kiev')::date AS d, COALESCE(SUM(total),0)::numeric AS rev
             FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2
            GROUP BY 1
           UNION ALL
           -- банки у візитах + POS-продажі з каси (без онлайн-замовлень — вони вище)
           SELECT (created_at AT TIME ZONE 'Europe/Kiev')::date AS d, COALESCE(SUM(amount),0)::numeric AS rev
             FROM cash_operations
            WHERE type='in' AND category='sale_product' AND ref_type IS DISTINCT FROM 'order'
              AND created_at BETWEEN $1 AND $2
            GROUP BY 1) t
          GROUP BY d
       ),
       serv AS (
         SELECT (created_at AT TIME ZONE 'Europe/Kiev')::date AS d, COALESCE(SUM(amount),0)::numeric AS rev
           FROM cash_operations
          WHERE type='in' AND category='sale_service' AND created_at BETWEEN $1 AND $2
          GROUP BY 1
       )
       SELECT days.d AS date,
              COALESCE(prod.rev,0)::numeric AS products,
              COALESCE(serv.rev,0)::numeric AS services,
              (COALESCE(prod.rev,0)+COALESCE(serv.rev,0))::numeric AS total
         FROM days
         LEFT JOIN prod ON prod.d = days.d
         LEFT JOIN serv ON serv.d = days.d
        ORDER BY days.d`,
      [from, to]
    );
    res.json({ period: { from, to }, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════════════════════════════════════════════════════
//  Расширенная аналитика (план месяца, услуги, загрузка)
// ════════════════════════════════════════════════════════

// Классификация услуги по названию/категории в укрупнённый сегмент.
// Порядок важен: педикюр проверяем до маникюра.
// Класифікація по НАЗВІ (специфічне раніше загального), категорія — лише запасний сигнал.
// Чому так: категорія «Брови та вії» змішана (і брови, і вії) + загальні слова
// «зняття»/«фарбування» раніше перехоплювали специфічні послуги:
//   «Зняття вій» → манікюр, «Фарбування брів» → фарбування волосся. Тепер ні.
function _svcMatch(t) {
  return {
    pedicure: /педик|pedic/.test(t),
    lashes:   /вій|вії|вие|вии|ресн|lash|hollywood/.test(t),
    brows:    /брів|брови|brow/.test(t),
    manicure: /манік|маник|manic|нігт|ногт|nail|френч|втирк|зняття|нарощенн.*ніг|нарощенн.*ногт/.test(t),
    coloring: /фарбув|покрас|окраш|колор|тонуван|airtouch|air\s*touch|шатуш|балаяж|melt|highlight|мелірув|освітл|вихід з чорн|корекц.*кольор/.test(t),
    hair:     /стрижк|зачіск|зачес|укладк|миття|вкладенн|hair|віднов|вирів|біовирів|biomimetic|кератин|ботокс|нанопласт|реконструкц|полірув|накрутк|вкладанн|контур|завивк|догляд.*волосс|волосс/.test(t),
  };
}
function classifyService(name, cat) {
  const order = ['pedicure', 'lashes', 'brows', 'manicure', 'coloring', 'hair'];
  const byName = _svcMatch(String(name || '').toLowerCase());
  for (const b of order) if (byName[b]) return b;
  const byCat = _svcMatch(String(cat || '').toLowerCase());
  for (const b of order) if (byCat[b]) return b;
  return 'other';
}
const SERVICE_BUCKETS = ['manicure','pedicure','coloring','lashes','brows','hair','other'];

// Локальная дата YYYY-MM-DD (без UTC-сдвига — как в календаре админки)
function ymdLocal(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
const WD = ['sun','mon','tue','wed','thu','fri','sat'];
// Сколько смен и рабочих минут у мастера по его графику за период [from..to]
function shiftsFromSchedule(sched, from, to) {
  if (!sched || typeof sched !== 'object') return { shifts: 0, minutes: 0, hasSchedule: false };
  const exc = sched.exceptions || {};
  let shifts = 0, minutes = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= end) {
    const day = sched[WD[cur.getDay()]];
    const key = ymdLocal(cur);
    const ex = exc[key];
    if (day && !(ex && ex.off)) {
      shifts++;
      const [sh, sm] = String(day.start || '0:0').split(':').map(Number);
      const [eh, em] = String(day.end   || '0:0').split(':').map(Number);
      let mins = (eh*60+em) - (sh*60+sm);
      if (day.break_start && day.break_end) {
        const [bsh, bsm] = String(day.break_start).split(':').map(Number);
        const [beh, bem] = String(day.break_end).split(':').map(Number);
        mins -= ((beh*60+bem) - (bsh*60+bsm));
      }
      if (mins > 0) minutes += mins;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return { shifts, minutes, hasSchedule: true };
}

// ── Клиенты по услугам ──────────────────────────────────
// GET /api/reports/clients-by-service?from=&to=&include=&exclude=
// include/exclude — список сегментов через запятую (manicure,pedicure,...)
// Возвращает клиентов с набором сегментов, которые они делали, + суммы.
router.get('/clients-by-service', requirePerm('reports.read'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const include = String(req.query.include || '').split(',').map(s=>s.trim()).filter(Boolean);
    const exclude = String(req.query.exclude || '').split(',').map(s=>s.trim()).filter(Boolean);

    const r = await pool.query(
      // Аудит 25.07: тут брали a.price (планову ціну) → недобирали 384 502 ₴ реальних грошей,
      // а INNER JOIN clients викидав 324 записи без прив'язки до клієнта (453 851 ₴).
      // Тепер сума — фактично отримана, а безіменні візити видно окремим рядком.
      `SELECT a.id AS appt_id, a.client_id,
              COALESCE(cl.name, NULLIF(a.client_name,''), '(візит без картки клієнта)') AS client_name, cl.phone,
              COALESCE(a.real_amount, a.price, 0) AS price, a.starts_at,
              s.name AS svc_name, s.category AS svc_cat
         FROM appointments a
         LEFT JOIN clients cl  ON cl.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.starts_at BETWEEN $1 AND $2
          AND a.status NOT IN ('cancelled','noshow')`,
      [from, to]
    );

    const map = new Map();
    for (const row of r.rows) {
      // Візити без картки клієнта НЕ можна зливати в один рядок: раніше вони всі падали
      // під ключ null, брали ім'я першого-ліпшого і ставали «клієнтом №1» з чужою сумою.
      // Кожен такий візит — окремий рядок із власним ключем.
      const key = row.client_id != null ? 'c' + row.client_id : 'a' + row.appt_id;
      if (!map.has(key)) {
        map.set(key, {
          client_id: row.client_id, name: row.client_name, phone: row.phone,
          no_card: row.client_id == null,
          total_visits: 0, total_sum: 0,
          buckets: Object.fromEntries(SERVICE_BUCKETS.map(b=>[b,{count:0,sum:0}])),
        });
      }
      const c = map.get(key);
      const b = classifyService(row.svc_name, row.svc_cat);
      const price = Number(row.price) || 0;
      c.buckets[b].count++; c.buckets[b].sum += price;
      c.total_visits++; c.total_sum += price;
    }

    let items = Array.from(map.values()).map(c => ({
      ...c,
      total_sum: Math.round(c.total_sum),
      did: SERVICE_BUCKETS.filter(b => c.buckets[b].count > 0),
    }));

    if (include.length) items = items.filter(c => include.every(b => c.buckets[b]?.count > 0));
    if (exclude.length) items = items.filter(c => exclude.every(b => !(c.buckets[b]?.count > 0)));
    items.sort((a,b) => b.total_sum - a.total_sum);

    // сводка по сегментам (по всем клиентам периода, без фильтра include/exclude)
    const summary = Object.fromEntries(SERVICE_BUCKETS.map(b=>[b,{clients:0,sum:0}]));
    for (const c of map.values())
      for (const b of SERVICE_BUCKETS)
        if (c.buckets[b].count > 0) { summary[b].clients++; summary[b].sum += c.buckets[b].sum; }
    for (const b of SERVICE_BUCKETS) summary[b].sum = Math.round(summary[b].sum);

    res.json({ period: { from, to }, count: items.length, items, summary });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Аналитика по мастеру: товары и услуги за период ─────
// GET /api/reports/master-detail?master_id=&from=&to=
router.get('/master-detail', requirePerm('reports.read'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const masterId = Number(req.query.master_id);
    if (!masterId) return res.status(400).json({ error: 'master_id required' });

    const mr = await pool.query(`SELECT id, name FROM masters WHERE id=$1`, [masterId]);
    if (!mr.rows.length) return res.status(404).json({ error: 'master not found' });

    // Услуги — из реально проведённых продаж кассы (стара CRM /sales), как и план месяца.
    // Раньше брали appointments.status='done', но стара CRM не присылает 'done'
    // (записи остаются confirmed) → отчёт показывал почти ноль. Касса = источник правды.
    const services = await pool.query(
      `SELECT COALESCE(NULLIF(description,''),'(без назви)') AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount),0)::numeric AS sum
         FROM cash_operations
        WHERE master_id = $1 AND type='in' AND category='sale_service'
          AND created_at BETWEEN $2 AND $3
        GROUP BY description ORDER BY sum DESC`,
      [masterId, from, to]
    );

    // Товары — продажи товаров мастером из кассы (то же, что в стара CRM)
    const products = await pool.query(
      `SELECT COALESCE(NULLIF(description,''),'(без назви)') AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount),0)::numeric AS sum
         FROM cash_operations
        WHERE master_id = $1 AND type='in' AND category='sale_product'
          AND created_at BETWEEN $2 AND $3
        GROUP BY description ORDER BY sum DESC`,
      [masterId, from, to]
    );

    const sSum = services.rows.reduce((a,r)=>a+Number(r.sum),0);
    const pSum = products.rows.reduce((a,r)=>a+Number(r.sum),0);
    res.json({
      master: mr.rows[0], period: { from, to },
      services: { total: Math.round(sSum), count: services.rows.reduce((a,r)=>a+r.count,0), items: services.rows },
      products: { total: Math.round(pSum), count: products.rows.reduce((a,r)=>a+r.count,0), items: products.rows },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Продажи товаров: по бренду / складу (филиалу) / периоду ─
// GET /api/reports/product-sales?from=&to=&brand=&branch=
router.get('/product-sales', requirePerm('reports.read'), cacheReport(), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const brand  = req.query.brand  ? String(req.query.brand)  : null;
    const branch = req.query.branch ? Number(req.query.branch) : null;

    // справочники для фильтров
    const brands   = await pool.query(`SELECT id, name FROM brands ORDER BY name`).catch(()=>({rows:[]}));
    const branches = await pool.query(`SELECT id, name FROM branches ORDER BY name`).catch(()=>({rows:[]}));

    const params = [from, to];
    let where = `o.status='paid' AND o.created_at BETWEEN $1 AND $2`;
    if (brand)  { params.push(brand);  where += ` AND p.brand_id = $${params.length}`; }
    if (branch) { params.push(branch); where += ` AND o.branch_id = $${params.length}`; }

    const byBrand = await pool.query(
      `SELECT COALESCE(b.name,'(без бренду)') AS brand,
              SUM(oi.qty)::int AS qty,
              COALESCE(SUM(oi.line_total),0)::numeric AS revenue
         FROM order_items oi
         JOIN orders o          ON o.id = oi.order_id
         LEFT JOIN product_variants pv ON pv.id = oi.variant_id
         LEFT JOIN products p    ON p.id = pv.product_id
         LEFT JOIN brands b      ON b.id = p.brand_id
        WHERE ${where}
        GROUP BY b.name ORDER BY revenue DESC`,
      params
    ).catch(e => ({ rows: [], _err: e.message }));

    const byProduct = await pool.query(
      `SELECT oi.product_name AS name, COALESCE(b.name,'') AS brand,
              SUM(oi.qty)::int AS qty,
              COALESCE(SUM(oi.line_total),0)::numeric AS revenue
         FROM order_items oi
         JOIN orders o          ON o.id = oi.order_id
         LEFT JOIN product_variants pv ON pv.id = oi.variant_id
         LEFT JOIN products p    ON p.id = pv.product_id
         LEFT JOIN brands b      ON b.id = p.brand_id
        WHERE ${where}
        GROUP BY oi.product_name, b.name ORDER BY revenue DESC LIMIT 500`,
      params
    ).catch((e) => { console.error('[reports] запит впав (у звіті нулі):', e.message); return { rows: [] }; });

    const total = byBrand.rows.reduce((a,r)=>a+Number(r.revenue),0);

    // ── Салонні продажі товарів (стара CRM, позиційно) ──
    const salonByProduct = await pool.query(
      `SELECT sps.product_name AS name,
              COALESCE(ss.category,'(без категорії)') AS category,
              SUM(sps.qty)::numeric AS qty,
              COALESCE(SUM(sps.total_price),0)::numeric AS revenue,
              bool_or(sps.matched) AS matched
         FROM salon_product_sales sps
         LEFT JOIN salon_stock ss ON ss.id = sps.stock_id
        WHERE sps.sale_date BETWEEN $1 AND $2
        GROUP BY sps.product_name, ss.category ORDER BY revenue DESC LIMIT 500`,
      [from, to]
    ).catch((e) => { console.error('[reports] запит впав (у звіті нулі):', e.message); return { rows: [] }; });
    const salonByCategory = await pool.query(
      `SELECT COALESCE(ss.category,'(без категорії)') AS category,
              SUM(sps.qty)::numeric AS qty,
              COALESCE(SUM(sps.total_price),0)::numeric AS revenue
         FROM salon_product_sales sps
         LEFT JOIN salon_stock ss ON ss.id = sps.stock_id
        WHERE sps.sale_date BETWEEN $1 AND $2
        GROUP BY ss.category ORDER BY revenue DESC`,
      [from, to]
    ).catch((e) => { console.error('[reports] запит впав (у звіті нулі):', e.message); return { rows: [] }; });
    const salonByMaster = await pool.query(
      `SELECT COALESCE(m.name, sps.master_name, '(без майстра)') AS master,
              SUM(sps.qty)::numeric AS qty,
              COALESCE(SUM(sps.total_price),0)::numeric AS revenue
         FROM salon_product_sales sps
         LEFT JOIN masters m ON m.id = sps.master_id
        WHERE sps.sale_date BETWEEN $1 AND $2
        GROUP BY COALESCE(m.name, sps.master_name, '(без майстра)') ORDER BY revenue DESC`,
      [from, to]
    ).catch((e) => { console.error('[reports] запит впав (у звіті нулі):', e.message); return { rows: [] }; });
    const salonTotal = salonByCategory.rows.reduce((a,r)=>a+Number(r.revenue),0);

    res.json({
      period: { from, to },
      filters: { brand, branch },
      brands: brands.rows, branches: branches.rows,
      total: Math.round(total),
      by_brand: byBrand.rows, by_product: byProduct.rows,
      salon: {
        total: Math.round(salonTotal),
        by_product: salonByProduct.rows,
        by_category: salonByCategory.rows,
        by_master: salonByMaster.rows,
      },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Загрузка салона (utilization) ───────────────────────
// GET /api/reports/utilization?from=&to=
// Занятое время = сумма длительностей записей; доступное — из графика мастера.
router.get('/utilization', requirePerm('reports.read'), cacheReport(), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const fromD = new Date(from), toD = new Date(to);

    const masters = await pool.query(`SELECT id, name, schedule_json FROM masters WHERE active=true ORDER BY name`);
    // Аудит 25.07: тривалості записів просто підсумовувались, а в базі 306 пар записів
    // ПЕРЕТИНАЮТЬСЯ в часі (паралельні послуги одного майстра, дубль-рядки одного візиту).
    // Через це «завантаження» доходило до 1457%. Тепер зайнятий час — це ОБʼЄДНАННЯ
    // інтервалів: перекриття рахується один раз (класичний sweep по відсортованих межах).
    const busy = await pool.query(
      `WITH iv AS (
         SELECT master_id, starts_at AS s, ends_at AS e
           FROM appointments
          WHERE starts_at BETWEEN $1 AND $2
            AND status NOT IN ('cancelled','noshow')
            AND ends_at IS NOT NULL AND ends_at > starts_at
       ),
       mark AS (
         SELECT master_id, s, e,
                MAX(e) OVER (PARTITION BY master_id ORDER BY s, e
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
           FROM iv
       ),
       grp AS (
         SELECT master_id, s, e,
                SUM(CASE WHEN prev_max IS NULL OR s > prev_max THEN 1 ELSE 0 END)
                  OVER (PARTITION BY master_id ORDER BY s, e) AS island
           FROM mark
       ),
       merged AS (
         SELECT master_id, MIN(s) AS s, MAX(e) AS e
           FROM grp GROUP BY master_id, island
       )
       SELECT m.master_id,
              COALESCE(SUM(EXTRACT(EPOCH FROM (m.e - m.s))/60),0)::numeric AS busy_min,
              (SELECT COUNT(*) FROM iv WHERE iv.master_id = m.master_id)::int AS appts
         FROM merged m
        GROUP BY m.master_id`, [from, to]
    );
    const busyMap = new Map(busy.rows.map(r => [r.master_id, r]));
    // Доступний час — з тієї ж сітки графіка, що бачить адмін (а не лише з тижневого
    // шаблону). Так % завантаження узгоджений з кількістю змін у плані місяця.
    const statMap = await shiftStatsByMasterInRange(pool, from.slice(0,10), to.slice(0,10)).catch(() => new Map());

    let salonBusy = 0, salonAvail = 0;
    const items = masters.rows.map(m => {
      const st = statMap.get(m.id) || { shifts: 0, minutes: 0 };
      const b = busyMap.get(m.id) || { busy_min: 0, appts: 0 };
      const busyMin = Math.round(Number(b.busy_min));
      const availMin = st.minutes;
      // В салонную загрузку берём только мастеров с заданным графиком,
      // иначе busy без avail задирает % выше 100.
      if (availMin > 0) { salonBusy += busyMin; salonAvail += availMin; }
      return {
        master_id: m.id, name: m.name,
        shifts: st.shifts, has_schedule: st.shifts > 0,
        busy_min: busyMin, avail_min: availMin, appts: b.appts,
        // стеля 100%: понад це — ознака накладок у графіку, а не понаднормової роботи
        util_pct: availMin > 0 ? Math.min(100, Math.round(busyMin / availMin * 100)) : null,
      };
    }).sort((a,b) => (b.util_pct||0) - (a.util_pct||0));

    res.json({
      period: { from, to },
      salon_util_pct: salonAvail > 0 ? Math.round(salonBusy / salonAvail * 100) : null,
      salon_busy_min: salonBusy, salon_avail_min: salonAvail,
      items,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── План месяца: список план/факт/% по всем мастерам ─────
// GET /api/reports/monthly-plan?year=&month=
router.get('/monthly-plan', requirePerm('reports.read'), async (req, res) => {
  try {
    const now = new Date();
    const year  = Number(req.query.year)  || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1);
    const fromD = new Date(year, month - 1, 1);
    const toD   = new Date(year, month, 0);
    const from  = ymdLocal(fromD), to = ymdLocal(toD);
    // верхняя граница для created_at — конец последнего дня
    const toTs  = new Date(year, month, 0, 23, 59, 59).toISOString();
    const fromTs = fromD.toISOString();

    const masters = await pool.query(`SELECT id, name, schedule_json FROM masters WHERE active=true ORDER BY name`);
    // Нотатка #162: план не переносився на новий місяць. Поточний місяць — дописуємо
    // останній план майстра в БД; майбутній — показуємо перенесений без запису.
    const { ensureMonthPlans, previewCarry } = require('../lib/month-plan');
    await ensureMonthPlans(pool, year, month);
    const plans = await pool.query(
      `SELECT master_id, plan_per_shift, plan_total, auto_from_shifts, carried_from
         FROM master_monthly_plans WHERE year=$1 AND month=$2`, [year, month]
    );
    const planMap = new Map(plans.rows.map(p => [p.master_id, p]));
    const preview = await previewCarry(pool, year, month);
    for (const [mid, p] of preview) if (!planMap.has(mid)) planMap.set(mid, p);

    // факт оборота (услуги+товары) по мастеру за месяц
    const rev = await pool.query(
      `SELECT master_id,
              COALESCE(SUM(amount),0)::numeric AS revenue
         FROM cash_operations
        WHERE type='in' AND category IN ('sale_service','sale_product')
          AND master_id IS NOT NULL
          AND created_at BETWEEN $1 AND $2
        GROUP BY master_id`, [fromTs, toTs]
    );
    const revMap = new Map(rev.rows.map(r => [r.master_id, Number(r.revenue)]));

    // фактически отработанные дни (distinct даты записей)
    const worked = await pool.query(
      `SELECT master_id, COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kiev')::date)::int AS days
         FROM appointments
        WHERE starts_at BETWEEN $1 AND $2 AND status NOT IN ('cancelled','noshow')
        GROUP BY master_id`, [fromTs, toTs]
    ).catch(()=>({rows:[]}));
    const workedMap = new Map(worked.rows.map(r => [r.master_id, r.days]));

    // Кількість змін рахуємо ТОЧНО як їх показує сітка графіка (Персонал → Графіки):
    // явні per-day рядки + розгорнутий тижневий шаблон - вихідні. Спільний модуль
    // schedule-month гарантує, що план і сітка ніколи не розійдуться в числах.
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const gridMap = await shiftDaysByMaster(pool, ym).catch(() => new Map());

    const items = masters.rows.map(m => {
      const p = planMap.get(m.id);
      const sc = shiftsFromSchedule(m.schedule_json, fromD, toD);
      const workedDays = workedMap.get(m.id) || 0;
      const gridDays = gridMap.get(m.id) || 0;
      // приоритет: реально виставлений графік (сітка) → тижневий шаблон → факт відпрацьовано
      const shifts = gridDays > 0 ? gridDays : (sc.hasSchedule ? sc.shifts : workedDays);
      const shiftSource = gridDays > 0 ? 'графік' : (sc.hasSchedule ? 'шаблон' : 'факт');
      const perShift = p ? Number(p.plan_per_shift) : 0;
      const auto = p ? p.auto_from_shifts : true;
      const planTotal = p
        ? (auto ? Math.round(perShift * shifts) : Number(p.plan_total))
        : 0;
      const revenue = Math.round(revMap.get(m.id) || 0);
      return {
        master_id: m.id, name: m.name,
        plan_per_shift: perShift, auto_from_shifts: auto,
        carried_from: p && p.carried_from ? p.carried_from : null,
        carried_preview: !!(p && p.preview),
        shifts_scheduled: gridDays || sc.shifts, shifts_worked: workedDays,
        shifts_used: shifts, has_schedule: gridDays > 0 || sc.hasSchedule,
        shift_source: shiftSource,
        plan_total: planTotal, revenue,
        pct: planTotal > 0 ? Math.round(revenue / planTotal * 100) : null,
      };
    });

    // Нотатка #163: підсумок рахуємо ТУТ, з тих самих рядків, що бачить таблиця, —
    // щоб «Разом» завжди дорівнював сумі колонок і не мав своєї окремої формули.
    const sum = (k) => items.reduce((a, it) => a + (Number(it[k]) || 0), 0);
    const totPlan = sum('plan_total'), totRev = sum('revenue');
    const totals = {
      plan_total: totPlan, revenue: totRev, shifts_used: sum('shifts_used'),
      pct: totPlan > 0 ? Math.round(totRev / totPlan * 100) : null,
      masters_with_plan: items.filter(it => it.plan_total > 0).length,
    };

    res.json({ year, month, period: { from, to }, items, totals });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/reports/day-plan?date=YYYY-MM-DD — ПЛАН НА ДЕНЬ (заметка #146, Босс 04.09).
// Скільки салон МАЄ заробити саме цього дня = сума планів на зміну тих майстрів,
// які за графіком працюють у цю дату. Джерела ті самі, що й «План місяця»
// (master_monthly_plans.plan_per_shift) і сітка графіків (buildMonthGrid) —
// тому цифри ніколи не розійдуться з розділом «План».
router.get('/day-plan', requirePerm('reports.read'), async (req, res) => {
  try {
    const { dayPlan } = require('../lib/day-plan');
    res.json(await dayPlan(pool, req.query.date));
  } catch (e) { console.error('[day-plan]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/reports/monthly-plan  — задать/обновить план мастера
// body: { master_id, year, month, plan_per_shift, plan_total, auto_from_shifts }
router.post('/monthly-plan', requirePerm('reports.read'), async (req, res) => {
  try {
    const { master_id, year, month } = req.body || {};
    if (!master_id || !year || !month) return res.status(400).json({ error: 'master_id, year, month required' });
    const perShift = Number(req.body.plan_per_shift) || 0;
    const planTotal = Number(req.body.plan_total) || 0;
    const auto = req.body.auto_from_shifts !== false;
    const r = await pool.query(
      `INSERT INTO master_monthly_plans (master_id, year, month, plan_per_shift, plan_total, auto_from_shifts)
            VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (master_id, year, month)
       DO UPDATE SET plan_per_shift=$4, plan_total=$5, auto_from_shifts=$6, carried_from=NULL, updated_at=NOW()
       RETURNING *`,
      [master_id, year, month, perShift, planTotal, auto]
    );
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Салонный обзор для дашборда (одним запросом) ─────────
// GET /api/reports/overview
// Салон-центричные метрики: касса сегодня/месяц из cash_operations,
// записи сегодня, новые клиенты, топ-мастера месяца. Деньги — при reports.finance.
router.get('/overview', requirePerm(), cacheReport(), async (req, res) => {
  try {
    // Границы суток и месяца по Киеву
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kiev', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
    const monthStr = todayStr.slice(0,7) + '-01';
    const dayFrom = kyivDayBound(todayStr, false).toISOString();
    const dayTo   = kyivDayBound(todayStr, true).toISOString();
    const monFrom = kyivDayBound(monthStr, false).toISOString();
    // Довільний період з ?from=&to= (YYYY-MM-DD). За замовчуванням — поточний місяць.
    const _dRe = /^\d{4}-\d{2}-\d{2}$/;
    const periodFrom = (req.query.from && _dRe.test(req.query.from)) ? kyivDayBound(req.query.from, false).toISOString() : monFrom;
    // Верхня межа = кінець дня (повний день/місяць). % майстрам капається на NOW() в liveFinance.
    const periodTo   = (req.query.to && _dRe.test(req.query.to)) ? kyivDayBound(req.query.to, true).toISOString() : kyivDayBound(todayStr, true).toISOString();

    // ── Кабінет майстра: тільки власні записи та виручка ──
    if (req.user.role === 'master' && req.user.master_id) {
      const mid = Number(req.user.master_id);
      const [todayA, monthA, nextA] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int AS done,
                           COUNT(*) FILTER (WHERE status IN ('booked','confirmed') AND starts_at > NOW())::int AS upcoming
                    FROM appointments WHERE master_id=$1 AND starts_at BETWEEN $2 AND $3`, [mid, dayFrom, dayTo]),
        // Виручку майстра беремо з КАСИ (стара CRM лишає візити 'confirmed' → appointments.price WHERE done недораховує вдвічі)
        pool.query(`SELECT
                      (SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int
                         FROM appointments WHERE master_id=$1 AND starts_at >= $2) AS done,
                      (SELECT COALESCE(SUM(amount),0)::numeric
                         FROM cash_operations WHERE master_id=$1 AND type='in'
                           AND category IN ('sale_service','sale_product') AND created_at >= $2) AS revenue`, [mid, monFrom]),
        pool.query(`SELECT a.starts_at, COALESCE(s.name,'Послуга') AS service_name,
                           COALESCE(NULLIF(c.name,''),'Клієнт') AS client_name
                    FROM appointments a LEFT JOIN services s ON s.id=a.service_id
                    LEFT JOIN clients c ON c.id=a.client_id
                    WHERE a.master_id=$1 AND a.starts_at >= $2
                      AND COALESCE(a.status,'') IN ('booked','confirmed')
                    ORDER BY a.starts_at LIMIT 5`, [mid, dayFrom]),
      ]);
      return res.json({
        is_master: true,
        master_id: mid,
        master_name: req.user.display_name || null,
        today: { appts: todayA.rows[0].total, appts_done: todayA.rows[0].done, appts_upcoming: todayA.rows[0].upcoming },
        month: { done: monthA.rows[0].done, revenue: Number(monthA.rows[0].revenue) },
        next_appointments: nextA.rows,
        finance_locked: false,
      });
    }

    const canFinance = hasPermission(req.user.permissions, 'reports.finance');

    const [revToday, revMonth, expMonth, apptToday, newClientsMonth, topMasters, openShift] = await Promise.all([
      // касса сегодня (услуги + товары)
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE category='sale_service'),0)::numeric AS svc,
                         COALESCE(SUM(amount) FILTER (WHERE category='sale_product'),0)::numeric AS prod
                  FROM cash_operations WHERE type='in' AND created_at BETWEEN $1 AND $2`, [dayFrom, dayTo]),
      // касса месяц
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE category='sale_service'),0)::numeric AS svc,
                         COALESCE(SUM(amount) FILTER (WHERE category='sale_product'),0)::numeric AS prod,
                         COUNT(*) FILTER (WHERE category IN ('sale_service','sale_product'))::int AS cnt
                  FROM cash_operations WHERE type='in' AND created_at BETWEEN $1 AND $2`, [periodFrom, periodTo]),
      // расходы (резерв, не используется — берём из live-finance)
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS sum FROM cash_operations WHERE type='out' AND created_at BETWEEN $1 AND $2`, [periodFrom, periodTo]),
      // записи сегодня по статусам
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int AS done,
                         COUNT(*) FILTER (WHERE status IN ('booked','confirmed') AND starts_at > NOW())::int AS upcoming
                  FROM appointments WHERE starts_at BETWEEN $1 AND $2`, [dayFrom, dayTo]),
      // новые клиенты за месяц — рахуємо за датою ПЕРШОГО візиту, а не clients.created_at
      // (вся база імпортована одним днем, тож created_at у всіх = дата імпорту → KPI був завищений у десятки разів)
      // Аудит 25.07: сюди потрапляли СКАСОВАНІ записи і майбутні брони → «нових клієнтів»
      // було 165 замість реальних 129 (+28%). Новий клієнт = той, хто реально дійшов.
      pool.query(`SELECT COUNT(*)::int AS n FROM (
                    SELECT client_id, MIN(starts_at) AS first_visit
                      FROM appointments
                     WHERE client_id IS NOT NULL
                       AND status NOT IN ('cancelled','noshow')
                       AND starts_at <= NOW()
                     GROUP BY client_id
                  ) t WHERE first_visit BETWEEN $1 AND $2`, [periodFrom, periodTo]).catch(()=>({rows:[{n:0}]})),
      // топ мастеров месяца по выручке — источник правды касса (стара CRM оставляет записи 'confirmed', а не 'done')
      pool.query(`SELECT m.id, m.name,
                         COALESCE(SUM(co.amount),0)::numeric AS revenue,
                         COUNT(*) FILTER (WHERE co.category='sale_service')::int AS done
                  FROM cash_operations co JOIN masters m ON m.id=co.master_id
                  WHERE co.type='in' AND co.category IN ('sale_service','sale_product')
                    AND co.created_at BETWEEN $1 AND $2
                  GROUP BY m.id, m.name
                  HAVING SUM(co.amount) > 0
                  ORDER BY revenue DESC LIMIT 8`, [periodFrom, periodTo]),
      pool.query(`SELECT COUNT(*)::int AS n FROM cash_shifts WHERE status='open'`).catch(()=>({rows:[{n:0}]})),
    ]);

    // Вчорашня дата (Київ) для розрахунку динаміки каси
    const yDate = new Date(now); yDate.setUTCDate(yDate.getUTCDate() - 1);
    const yStr = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kiev', year:'numeric', month:'2-digit', day:'2-digit' }).format(yDate);
    const yFrom = kyivDayBound(yStr, false).toISOString();
    const yTo   = kyivDayBound(yStr, true).toISOString();

    const [clientsTotal, revYesterday, doneMonth, churnQ, lowStockQ] = await Promise.all([
      // Аудит: считали ВСЕХ клиентов включая удалённых → дашборд завышал число.
      // Только живые (deleted_at IS NULL), как и остальные экраны.
      pool.query(`SELECT COUNT(*)::int AS n FROM clients WHERE deleted_at IS NULL`),
      // каса вчора (для тренду ±%) — рахуємо завжди, віддаємо лише при фінансах
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total
                  FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product')
                    AND created_at BETWEEN $1 AND $2`, [yFrom, yTo]).catch(()=>({rows:[{total:0}]})),
      // виконано записів за місяць (для середнього чека і KPI) = реально проведені візити (не лише 'done')
      pool.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int AS done
                  FROM appointments WHERE starts_at BETWEEN $1 AND $2`, [periodFrom, periodTo]).catch(()=>({rows:[{done:0}]})),
      // відтік: єдине визначення (cadence-aware) з lib/churn.js — синхронно з дашбордом і AI
      pool.query(CHURN_COUNT_SQL).catch(()=>({rows:[{n:0}]})),
      // позицій на виході (≤ поріг)
      pool.query(`SELECT COUNT(*)::int AS n FROM product_variants WHERE active = true AND COALESCE(stock_qty,0) <= 5`).catch(()=>({rows:[{n:0}]})),
    ]);

    const out = {
      today: { appts: apptToday.rows[0].total, appts_done: apptToday.rows[0].done, appts_upcoming: apptToday.rows[0].upcoming },
      clients_total: clientsTotal.rows[0].n,
      new_clients_month: newClientsMonth.rows[0].n,
      open_shifts: openShift.rows[0].n,
      done_month: doneMonth.rows[0].done,
      churn_clients: churnQ.rows[0].n,
      low_stock_count: lowStockQ.rows[0].n,
      finance_locked: !canFinance,
    };
    if (canFinance) {
      const rt = revToday.rows[0], rm = revMonth.rows[0];
      out.revenue_today = { services: Number(rt.svc), products: Number(rt.prod), total: Number(rt.svc) + Number(rt.prod) };
      out.revenue_yesterday = Number(revYesterday.rows[0].total);
      out.period = { from: (req.query.from && _dRe.test(req.query.from)) ? req.query.from : monthStr, to: (req.query.to && _dRe.test(req.query.to)) ? req.query.to : todayStr };
      // ЄДИНЕ джерело правди — lib/live-finance: виручка/витрати/прибуток за обраний період.
      const finMonth = await liveFinance(pool, periodFrom, periodTo);
      out.revenue_month = finMonth.revenue;
      out.expense_month = finMonth.expenses.total;
      out.profit_month = finMonth.profit.net;
      out.master_commission_month = finMonth.expenses.commission;
      // Аудит 25.07: тут ділили на кількість КАСОВИХ ОПЕРАЦІЙ, а дашборд — на кількість рядків
      // записів. Через це один і той самий середній чек мав три різні значення (1123/1379/1737).
      // Єдиний знаменник для всієї CRM — реальні візити: унікальна пара «клієнт + день».
      const visitsCnt = await pool.query(
        `SELECT COUNT(DISTINCT (COALESCE(client_id::text, 'anon-'||id),
                                (starts_at AT TIME ZONE 'Europe/Kyiv')::date))::int AS n
           FROM appointments
          WHERE starts_at BETWEEN $1 AND $2 AND starts_at <= NOW()
            AND status NOT IN ('cancelled','noshow')`,
        [periodFrom, periodTo]).catch((e) => { console.error('[reports] лічильник впав (буде 0):', e.message); return { rows: [{ n: 0 }] }; });
      const visitsN = Number(visitsCnt.rows[0]?.n || 0);
      out.visits_month = visitsN;
      out.avg_check_month = visitsN > 0 ? Math.round(out.revenue_month.total / visitsN) : 0;
      out.top_masters = topMasters.rows.map(r => ({ id: r.id, name: r.name, revenue: Number(r.revenue), done: r.done }));
    } else {
      out.top_masters = topMasters.rows.map(r => ({ id: r.id, name: r.name, done: r.done }));
    }
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/reports/live-expenses — РЕАЛЬНІ витрати «на цю секунду» за поточний місяць:
// собівартість матеріалів + НАРАХОВАНИЙ % майстрам по реальних схемах (за завершені послуги)
// + інші витрати каси (оренда, реклама...). Оновлюється щойно проходить послуга.
router.get('/live-expenses', requirePerm('reports.finance'), async (req, res) => {
  try {
    const monStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit' }).format(new Date()) + '-01';
    const _dRe = /^\d{4}-\d{2}-\d{2}$/;
    const _today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const from = (req.query.from && _dRe.test(req.query.from)) ? kyivDayBound(req.query.from, false).toISOString() : kyivDayBound(monStr, false).toISOString();
    const to = (req.query.to && _dRe.test(req.query.to)) ? kyivDayBound(req.query.to, true).toISOString() : kyivDayBound(_today, true).toISOString();
    const f = await liveFinance(pool, from, to);
    res.json({
      period: monStr,
      revenue: f.revenue.total,
      breakdown: f.expenses.by_category,
      commission: f.expenses.commission, materials: f.expenses.materials, other: f.expenses.other,
      total: f.expenses.total,
      profit: f.profit.net,
      commission_appts: f.commission_appts,
    });
  } catch (e) { console.error('[live-expenses]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /api/reports/top-masters?from=&to= — топ майстрів за виручкою за довільний період.
// Джерело правди — каса (cash_operations), як і в /overview. Без from/to → поточний місяць.
router.get('/top-masters', requirePerm('reports.finance'), cacheReport(), async (req, res) => {
  try {
    let from, to;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (req.query.from && dateRe.test(req.query.from)) {
      from = kyivDayBound(req.query.from, false).toISOString();
      to = (req.query.to && dateRe.test(req.query.to))
        ? kyivDayBound(req.query.to, true).toISOString()
        : kyivDayBound(req.query.from, true).toISOString();
    } else {
      // дефолт — поточний календарний місяць по Києву
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kiev', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      from = kyivDayBound(todayStr.slice(0,7) + '-01', false).toISOString();
      to = new Date().toISOString();
    }
    // Дохід майстра = ПОСЛУГИ за візитами з матеріалами (як у Буконі: повна ціна візиту,
    // краски/розхідники всередині), але БЕЗ проданих товарів. Джерело — appointments (не каса,
    // бо каса містила відновлення/перекатегоризацію). Продані товари — ОКРЕМО: роздрібні продажі.
    const r = await pool.query(
      `WITH svc AS (
         SELECT a.master_id,
                COALESCE(SUM(COALESCE(a.real_amount,a.price,0)),0)::numeric AS revenue_services,
                COUNT(*)::int AS done
           FROM appointments a
          WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
            AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
          GROUP BY a.master_id
       ),
       prod AS (
         SELECT master_id, COALESCE(SUM(amount),0)::numeric AS revenue_products
           FROM cash_operations
          WHERE type='in' AND category='sale_product' AND ref_type IS NULL
            AND created_at BETWEEN $1 AND $2 AND master_id IS NOT NULL
          GROUP BY master_id
       )
       SELECT m.id, m.name,
              COALESCE(s.revenue_services,0)::numeric AS revenue_services,
              COALESCE(p.revenue_products,0)::numeric AS revenue_products,
              (COALESCE(s.revenue_services,0)+COALESCE(p.revenue_products,0))::numeric AS revenue,
              COALESCE(s.done,0)::int AS done
         FROM masters m
         LEFT JOIN svc s ON s.master_id=m.id
         LEFT JOIN prod p ON p.master_id=m.id
        WHERE COALESCE(s.revenue_services,0) > 0 OR COALESCE(p.revenue_products,0) > 0
        ORDER BY revenue_services DESC LIMIT 20`, [from, to]);
    res.json({ from, to, masters: r.rows.map(x => ({ id: x.id, name: x.name, revenue: Number(x.revenue), revenue_services: Number(x.revenue_services), revenue_products: Number(x.revenue_products), done: x.done })) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* GET /api/reports/duplicates?days=60 — детектор задвоенной выручки.
   Аудит 28.07: касса завышалась записями-близнецами (двойной клик админа). Механизм
   закрыт индексом uq_appt_no_exact_dup (миграция 285), но нужен ПОСТОЯННЫЙ контроль:
   дубли бывают и «не точные» (тот же клиент и услуга в один день, но другое время —
   админ не нашёл запись и создал заново). Такое база запретить не может: это может быть
   и настоящий повторный визит. Поэтому — отчёт для человека, а не блокировка.
   Класс A (exact)   — тот же мастер/время/клиент/услуга: почти наверняка дубль.
   Класс B (same_day) — тот же клиент/услуга в один день, разное время: проверить. */
router.get('/duplicates', requirePerm('reports.finance'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 365);
    const paidSum = `(SELECT COALESCE(SUM(o.amount),0)::numeric FROM cash_operations o
                       WHERE o.ref_type='appointment' AND o.ref_id=a.id AND o.type='in')`;
    const base = `FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
       WHERE a.status NOT IN ('cancelled','noshow') AND a.client_id IS NOT NULL AND a.service_id IS NOT NULL
         AND COALESCE(a.legacy_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')
         AND a.starts_at >= NOW() - ($1 || ' days')::interval`;
    const rows = await pool.query(
      `WITH x AS (
         SELECT a.id, a.master_id, a.starts_at, a.client_id, a.service_id,
                COALESCE(c.name, a.client_name, '?') AS client,
                ${paidSum} AS paid ${base}
       ),
       exact AS (
         SELECT 'exact' AS kind, master_id, client, service_id,
                to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS day,
                array_agg(id ORDER BY id) AS ids, array_agg(paid ORDER BY id) AS paid_each,
                SUM(paid) - MAX(paid) AS excess
         FROM x GROUP BY master_id, client, service_id, starts_at, day HAVING COUNT(*) > 1
       ),
       same_day AS (
         SELECT 'same_day' AS kind, master_id, client, service_id,
                to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS day,
                array_agg(id ORDER BY id) AS ids, array_agg(paid ORDER BY id) AS paid_each,
                SUM(paid) - MAX(paid) AS excess
         FROM x GROUP BY master_id, client, service_id, day HAVING COUNT(*) > 1
       )
       SELECT * FROM exact
       UNION ALL
       SELECT sd.* FROM same_day sd
        WHERE NOT EXISTS (SELECT 1 FROM exact e WHERE e.ids && sd.ids)
       ORDER BY day DESC`, [days]).then(r => r.rows).catch((e) => {
      // Аудит 13.08: детектор задвоєних оплат при збої повертав ПОРОЖНЬО, тобто рапортував
      // «подвійних оплат немає». Це найгірший вид фоллбеку — фальшива гарантія чистоти.
      // Тепер збій прокидається нагору й користувач бачить помилку, а не «все чисто».
      console.error('[reports:duplicate-revenue] запит впав', e.message);
      throw e;
    });

    const items = rows.map(r => ({
      kind: r.kind, day: r.day, client: r.client, master_id: r.master_id,
      appointment_ids: r.ids, paid_each: (r.paid_each || []).map(Number),
      excess_amount: Math.round(Number(r.excess || 0) * 100) / 100,
      hint: r.kind === 'exact'
        ? 'Точний близнюк — той самий клієнт, послуга і хвилина. Майже напевно подвійний клік.'
        : 'Той самий клієнт і послуга в один день у різний час — перевірити, чи це справді два візити.',
    }));
    res.json({
      ok: true, days,
      total_excess: Math.round(items.reduce((s, i) => s + i.excess_amount, 0) * 100) / 100,
      count: items.length, items,
    });
  } catch (e) { console.error('[reports:duplicates]', e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
