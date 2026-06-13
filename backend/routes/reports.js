/* Reports: P&L, KPI мастеров, RFM-сегментация, отток
   Все эндпоинты требуют reports.read */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, hasPermission } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

function parsePeriod(q) {
  const end   = q.to   ? new Date(q.to)   : new Date();
  const start = q.from ? new Date(q.from) : new Date(end.getTime() - 30*86400*1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

// ── P&L (Profit & Loss) ─────────────────────────────────
// GET /api/reports/pnl?from=&to=
router.get('/pnl', requirePerm('reports.finance'), async (req, res) => {
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

    // COGS (себестоимость проданных товаров) — расходные движения по заказам × оптовая цена варианта
    const cogs = await pool.query(
      `SELECT COALESCE(SUM(ABS(sm.delta) * COALESCE(pv.wholesale,0)),0)::numeric AS cogs
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id = sm.variant_id
        WHERE sm.reason LIKE 'order:%' AND sm.delta < 0
          AND sm.created_at BETWEEN $1 AND $2`,
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
router.get('/masters', requirePerm('reports.finance'), async (req, res) => {
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
        HAVING MAX(a.starts_at) < NOW() - make_interval(days => $1)
           AND COUNT(a.id) >= 2
        ORDER BY MAX(a.starts_at) ASC
        LIMIT 500`, [days]
    );
    res.json({ threshold_days: days, items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Сводный дашборд (одним запросом) ────────────────────
// GET /api/reports/dashboard
// Дашборд видит любой с reports.read (домашняя страница админа).
// Месячную выручку и общую фин.статистику отдаём ТОЛЬКО при reports.finance.
router.get('/dashboard', requirePerm('reports.read'), async (req, res) => {
  try {
    const canFinance = hasPermission(req.user.permissions, 'reports.finance');
    const today = new Date(); today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayRev, lowStock, openShifts, churnCnt] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0)::numeric AS rev FROM orders WHERE status='paid' AND created_at >= $1`, [today.toISOString()]),
      pool.query(`SELECT COUNT(*)::int AS n FROM product_variants WHERE stock <= COALESCE(low_stock_threshold,5)`).catch(()=>({rows:[{n:0}]})),
      pool.query(`SELECT COUNT(*)::int AS n FROM cash_shifts WHERE status='open'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM (
         SELECT c.id FROM clients c
         JOIN appointments a ON a.client_id=c.id AND a.status='completed'
         GROUP BY c.id
         HAVING MAX(a.starts_at) < NOW() - INTERVAL '90 days' AND COUNT(a.id) >= 2
       ) t`),
    ]);

    const out = {
      revenue_today: Number(todayRev.rows[0].rev),
      low_stock_items: lowStock.rows[0].n,
      open_shifts: openShifts.rows[0].n,
      churn_clients: churnCnt.rows[0].n,
      finance_locked: !canFinance,
    };
    // Месячная выручка — только для владельца / при reports.finance
    if (canFinance) {
      const monthRev = await pool.query(
        `SELECT COALESCE(SUM(total),0)::numeric AS rev FROM orders WHERE status='paid' AND created_at >= $1`,
        [monthStart.toISOString()]
      );
      out.revenue_month = Number(monthRev.rows[0].rev);
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Дневная динамика выручки (для графика) ──────────────
// GET /api/reports/revenue-series?from=&to=
router.get('/revenue-series', requirePerm('reports.finance'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const r = await pool.query(
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, '1 day')::date AS d
       ),
       prod AS (
         SELECT created_at::date AS d, COALESCE(SUM(total),0)::numeric AS rev
           FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2
          GROUP BY 1
       ),
       serv AS (
         SELECT created_at::date AS d, COALESCE(SUM(amount),0)::numeric AS rev
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
//  Расширенная аналитика (план месяца, услуги, загрузка)
// ════════════════════════════════════════════════════════

// Классификация услуги по названию/категории в укрупнённый сегмент.
// Порядок важен: педикюр проверяем до маникюра.
function classifyService(text) {
  const t = String(text || '').toLowerCase();
  if (/педик|pedic/.test(t)) return 'pedicure';
  if (/манік|маник|manic|нігт|ногт|nail/.test(t)) return 'manicure';
  if (/фарбув|покрас|окраш|колор|тонуван|airtouch|air\s*touch|шатуш|балаяж|melt|highlight|мелірув|освітл/.test(t)) return 'coloring';
  if (/вій|вии|ресн|lash|нарощенн.*ві|ламінув.*ві/.test(t)) return 'lashes';
  if (/брів|брови|brow/.test(t)) return 'brows';
  if (/стрижк|зачіск|зачес|укладк|миття|вкладенн|hair/.test(t)) return 'hair';
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
      `SELECT a.client_id, cl.name AS client_name, cl.phone,
              a.price, a.starts_at,
              s.name AS svc_name, s.category AS svc_cat
         FROM appointments a
         JOIN clients cl  ON cl.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.starts_at BETWEEN $1 AND $2
          AND a.status NOT IN ('cancelled','noshow')`,
      [from, to]
    );

    const map = new Map();
    for (const row of r.rows) {
      if (!map.has(row.client_id)) {
        map.set(row.client_id, {
          client_id: row.client_id, name: row.client_name, phone: row.phone,
          total_visits: 0, total_sum: 0,
          buckets: Object.fromEntries(SERVICE_BUCKETS.map(b=>[b,{count:0,sum:0}])),
        });
      }
      const c = map.get(row.client_id);
      const b = classifyService(`${row.svc_name||''} ${row.svc_cat||''}`);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    // Услуги — по выполненным записям мастера, сгруппированы по названию
    const services = await pool.query(
      `SELECT COALESCE(s.name,'(без послуги)') AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(a.price),0)::numeric AS sum
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.master_id = $1 AND a.status = 'done'
          AND a.starts_at BETWEEN $2 AND $3
        GROUP BY s.name ORDER BY sum DESC`,
      [masterId, from, to]
    );

    // Товары — продажи товаров, привязанные к мастеру (cash_operations sale_product)
    const products = await pool.query(
      `SELECT COALESCE(NULLIF(description,''),'Товар') AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount),0)::numeric AS sum
         FROM cash_operations
        WHERE category='sale_product' AND type='in' AND master_id=$1
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Продажи товаров: по бренду / складу (филиалу) / периоду ─
// GET /api/reports/product-sales?from=&to=&brand=&branch=
router.get('/product-sales', requirePerm('reports.read'), async (req, res) => {
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
    ).catch(() => ({ rows: [] }));

    const total = byBrand.rows.reduce((a,r)=>a+Number(r.revenue),0);
    res.json({
      period: { from, to },
      filters: { brand, branch },
      brands: brands.rows, branches: branches.rows,
      total: Math.round(total),
      by_brand: byBrand.rows, by_product: byProduct.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Загрузка салона (utilization) ───────────────────────
// GET /api/reports/utilization?from=&to=
// Занятое время = сумма длительностей записей; доступное — из графика мастера.
router.get('/utilization', requirePerm('reports.read'), async (req, res) => {
  try {
    const { from, to } = parsePeriod(req.query);
    const fromD = new Date(from), toD = new Date(to);

    const masters = await pool.query(`SELECT id, name, schedule_json FROM masters WHERE active=true ORDER BY name`);
    const busy = await pool.query(
      `SELECT master_id,
              COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - starts_at))/60),0)::numeric AS busy_min,
              COUNT(*)::int AS appts
         FROM appointments
        WHERE starts_at BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','noshow')
          AND ends_at IS NOT NULL
        GROUP BY master_id`, [from, to]
    );
    const busyMap = new Map(busy.rows.map(r => [r.master_id, r]));

    let salonBusy = 0, salonAvail = 0;
    const items = masters.rows.map(m => {
      const sc = shiftsFromSchedule(m.schedule_json, fromD, toD);
      const b = busyMap.get(m.id) || { busy_min: 0, appts: 0 };
      const busyMin = Math.round(Number(b.busy_min));
      const availMin = sc.minutes;
      salonBusy += busyMin; salonAvail += availMin;
      return {
        master_id: m.id, name: m.name,
        shifts: sc.shifts, has_schedule: sc.hasSchedule,
        busy_min: busyMin, avail_min: availMin, appts: b.appts,
        util_pct: availMin > 0 ? Math.round(busyMin / availMin * 100) : null,
      };
    }).sort((a,b) => (b.util_pct||0) - (a.util_pct||0));

    res.json({
      period: { from, to },
      salon_util_pct: salonAvail > 0 ? Math.round(salonBusy / salonAvail * 100) : null,
      salon_busy_min: salonBusy, salon_avail_min: salonAvail,
      items,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const plans = await pool.query(
      `SELECT master_id, plan_per_shift, plan_total, auto_from_shifts
         FROM master_monthly_plans WHERE year=$1 AND month=$2`, [year, month]
    );
    const planMap = new Map(plans.rows.map(p => [p.master_id, p]));

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

    const items = masters.rows.map(m => {
      const p = planMap.get(m.id);
      const sc = shiftsFromSchedule(m.schedule_json, fromD, toD);
      const workedDays = workedMap.get(m.id) || 0;
      const shifts = sc.hasSchedule ? sc.shifts : workedDays;
      const perShift = p ? Number(p.plan_per_shift) : 0;
      const auto = p ? p.auto_from_shifts : true;
      const planTotal = p
        ? (auto ? Math.round(perShift * shifts) : Number(p.plan_total))
        : 0;
      const revenue = Math.round(revMap.get(m.id) || 0);
      return {
        master_id: m.id, name: m.name,
        plan_per_shift: perShift, auto_from_shifts: auto,
        shifts_scheduled: sc.shifts, shifts_worked: workedDays,
        shifts_used: shifts, has_schedule: sc.hasSchedule,
        plan_total: planTotal, revenue,
        pct: planTotal > 0 ? Math.round(revenue / planTotal * 100) : null,
      };
    });

    res.json({ year, month, period: { from, to }, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
       DO UPDATE SET plan_per_shift=$4, plan_total=$5, auto_from_shifts=$6, updated_at=NOW()
       RETURNING *`,
      [master_id, year, month, perShift, planTotal, auto]
    );
    res.json({ ok: true, plan: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
