/* ═══════════════════════════════════════════════════════
   INF-07 — DATA WAREHOUSE (Хранилище данных)
   Монтується як /api/dwh

   Аналітичне хранилище (star-schema) поверх оперативної БД (OLTP). ETL наживо
   тягне дані з appointments/orders/cash_operations/payroll_records/clients/
   masters/services/product_variants → вимірювання (dim) + факти (fact).
   Запити агрегацій ідуть по факт-таблицях — не нагружають OLTP. Єдине джерело
   даних для INF-08 BI та AI-04 Analytics.

   Реальне (на живих даних):
     • реєстр ETL-джобів + лог виконань (статус/рядки/quality/reconciliation);
     • реєстр джерел даних + health-check;
     • star-schema: dim_time/clients/services/staff/products + fact_visits/
       sales/payments/staff_payroll, наповнюються інкрементально (CDC по src_id);
     • запит до вітрини (SELECT-only, авто-LIMIT), схема DWH, свежесть даних,
       materialized-views-стиль агрегати (refresh пересчитує факт-таблиці).

   Graceful-стаб: зовнішні BI (bigquery/snowflake/redshift) у dwh_data_sources
   зберігаються, але test/health повертає 'unknown' поки не сконфігуровано —
   звіт/ETL від цього не падає.

   Backward-compat: старі роути /status /etl /etl-runs /quality /facts
   (поверх legacy dwh_fact_visits/dwh_etl_runs з міграції 116) збережені.

   Права: dwh.read (GET) / dwh.manage (мутації/ETL). Owner '*' матчить усе.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { isPlatformTenant } = require('../lib/tenant');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('dwh.read');
const MANAGE = requirePerm('dwh.manage');
// DWH fact/dim таблиці ще БЕЗ tenant_id — довільний SQL (/query) читав би дані всіх салонів.
// До повної ізоляції DWH дозволяємо сирий SQL лише платформенному тенанту (оператор).
// Звичайні салони користуються готовими звітами (reports/*). (SaaS-аудит 06.07)
function platformOnly(req, res, next) {
  if (isPlatformTenant && isPlatformTenant()) return next();
  return res.status(403).json({ error: 'dwh_platform_only',
    message: 'Довільні DWH-запити доступні лише оператору платформи. Користуйтесь готовими звітами.' });
}
const errOut = (e) => process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
const num = (v) => Number(v || 0);

// safe-обгортка: відсутня таблиця/колонка не валить ендпоінт (→ fallback)
async function safeRows(sql, params = [], fallback = []) {
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (e) { console.warn('[dwh] query skipped:', e.message); return fallback; }
}

const DONE = `a.status IN ('done','completed','paid','finished','closed')`;

// ════════════════════════════════════════════════════════════════════
//  ETL PIPELINES (реальна загрузка з OLTP у star-schema)
// ════════════════════════════════════════════════════════════════════

// dim_time: добудувати календарний вимір на діапазон дат з фактів
async function etlDimTime() {
  // межі: від найранішого OLTP-факту до сьогодні+1рік (з запасом)
  const r = await pool.query(`
    INSERT INTO dwh_dim_time (time_key, full_date, year, quarter, month, month_name,
        week, day_of_week, day_name, is_weekend)
    SELECT to_char(d,'YYYYMMDD')::int, d::date,
           EXTRACT(YEAR FROM d)::smallint, EXTRACT(QUARTER FROM d)::smallint,
           EXTRACT(MONTH FROM d)::smallint,
           CASE EXTRACT(MONTH FROM d)::int
             WHEN 1 THEN 'Січень' WHEN 2 THEN 'Лютий' WHEN 3 THEN 'Березень'
             WHEN 4 THEN 'Квітень' WHEN 5 THEN 'Травень' WHEN 6 THEN 'Червень'
             WHEN 7 THEN 'Липень' WHEN 8 THEN 'Серпень' WHEN 9 THEN 'Вересень'
             WHEN 10 THEN 'Жовтень' WHEN 11 THEN 'Листопад' ELSE 'Грудень' END,
           EXTRACT(WEEK FROM d)::smallint,
           EXTRACT(ISODOW FROM d)::smallint,
           CASE EXTRACT(ISODOW FROM d)::int
             WHEN 1 THEN 'Понеділок' WHEN 2 THEN 'Вівторок' WHEN 3 THEN 'Середа'
             WHEN 4 THEN 'Четвер' WHEN 5 THEN 'Пʼятниця' WHEN 6 THEN 'Субота' ELSE 'Неділя' END,
           EXTRACT(ISODOW FROM d)::int >= 6
    FROM generate_series(
      LEAST(COALESCE((SELECT MIN(starts_at)::date FROM appointments), CURRENT_DATE), (CURRENT_DATE - INTERVAL '90 days')::date)::timestamp,
      (CURRENT_DATE + INTERVAL '365 days')::timestamp, INTERVAL '1 day') d
    ON CONFLICT (time_key) DO NOTHING`);
  return { extracted: r.rowCount, loaded: r.rowCount, rejected: 0 };
}

// SCD2-стиль upsert для dim (тут спрощено: insert нових natural-key, без версіонування
// історії — поточний рядок is_current=true; зміни атрибутів оновлюють поточний).
async function etlDimClients() {
  const r = await pool.query(`
    INSERT INTO dwh_dim_clients (client_src_id, full_name, phone_hash, segment, first_visit_date, source, is_current)
    SELECT c.id, c.name, md5(COALESCE(c.phone,'')),
           CASE WHEN c.total_spent >= 10000 THEN 'VIP'
                WHEN c.last_visit_at IS NULL THEN 'New'
                WHEN c.last_visit_at < now() - INTERVAL '180 days' THEN 'Churned'
                ELSE 'Regular' END,
           (SELECT MIN(a.starts_at)::date FROM appointments a WHERE a.client_id=c.id),
           c.source, TRUE
    FROM clients c
    ON CONFLICT (client_src_id, is_current) DO UPDATE SET
      full_name=EXCLUDED.full_name, phone_hash=EXCLUDED.phone_hash,
      segment=EXCLUDED.segment, source=EXCLUDED.source, valid_from=now()`);
  return { extracted: r.rowCount, loaded: r.rowCount, rejected: 0 };
}

async function etlDimServices() {
  const r = await pool.query(`
    INSERT INTO dwh_dim_services (service_src_id, name, category, base_price, duration_min, is_current)
    SELECT s.id, s.name, s.category, s.price, s.duration_min, TRUE FROM services s
    ON CONFLICT (service_src_id, is_current) DO UPDATE SET
      name=EXCLUDED.name, category=EXCLUDED.category,
      base_price=EXCLUDED.base_price, duration_min=EXCLUDED.duration_min, valid_from=now()`);
  return { extracted: r.rowCount, loaded: r.rowCount, rejected: 0 };
}

async function etlDimStaff() {
  const r = await pool.query(`
    INSERT INTO dwh_dim_staff (staff_src_id, full_name, role, specialization, is_current)
    SELECT m.id, m.name, 'master', m.specialty, TRUE FROM masters m
    ON CONFLICT (staff_src_id, is_current) DO UPDATE SET
      full_name=EXCLUDED.full_name, specialization=EXCLUDED.specialization, valid_from=now()`);
  return { extracted: r.rowCount, loaded: r.rowCount, rejected: 0 };
}

async function etlDimProducts() {
  const r = await pool.query(`
    INSERT INTO dwh_dim_products (product_src_id, name, brand, category, sku, cost_price, retail_price, is_current)
    SELECT pv.id, COALESCE(p.name, 'товар'), b.name, cat.name, pv.sku, pv.wholesale, pv.price, TRUE
    FROM product_variants pv
    LEFT JOIN products p ON p.id=pv.product_id
    LEFT JOIN brands b ON b.id=p.brand_id
    LEFT JOIN categories cat ON cat.id=p.category_id
    ON CONFLICT (product_src_id, is_current) DO UPDATE SET
      name=EXCLUDED.name, brand=EXCLUDED.brand, category=EXCLUDED.category,
      sku=EXCLUDED.sku, cost_price=EXCLUDED.cost_price, retail_price=EXCLUDED.retail_price, valid_from=now()`);
  return { extracted: r.rowCount, loaded: r.rowCount, rejected: 0 };
}

// fact_visits: проведені візити (CDC по visit_src_id). Reconciliation: OLTP-сума vs DWH.
async function etlFactVisits() {
  const ins = await pool.query(`
    INSERT INTO dwh_fact_visits_v2 (visit_src_id, time_key, client_key, staff_key, service_key,
        branch_id, visit_date, visit_time, duration_min, status, revenue, is_first_visit, source)
    SELECT a.id,
           to_char(a.starts_at,'YYYYMMDD')::int,
           dc.client_key, ds.staff_key, dsv.service_key,
           a.branch_id, a.starts_at::date, a.starts_at::time,
           COALESCE(s.duration_min, EXTRACT(EPOCH FROM (a.ends_at - a.starts_at))/60)::int,
           CASE WHEN a.status IN ('done','completed','paid','finished','closed') THEN 'completed'
                WHEN a.status='noshow' THEN 'no_show' ELSE a.status END,
           COALESCE(a.price, 0),
           NOT EXISTS (SELECT 1 FROM appointments a2 WHERE a2.client_id=a.client_id AND a2.starts_at < a.starts_at),
           a.source
    FROM appointments a
    LEFT JOIN services s ON s.id=a.service_id
    LEFT JOIN dwh_dim_clients dc ON dc.client_src_id=a.client_id AND dc.is_current
    LEFT JOIN dwh_dim_staff ds ON ds.staff_src_id=a.master_id AND ds.is_current
    LEFT JOIN dwh_dim_services dsv ON dsv.service_src_id=a.service_id AND dsv.is_current
    WHERE ${DONE} AND a.starts_at IS NOT NULL
    ON CONFLICT (visit_src_id) DO NOTHING
    RETURNING id`);
  // reconciliation: сума виручки OLTP (done) vs DWH
  const rec = await safeRows(`
    SELECT (SELECT COALESCE(SUM(price),0) FROM appointments a WHERE ${DONE}) AS oltp_sum,
           (SELECT COALESCE(SUM(revenue),0) FROM dwh_fact_visits_v2) AS dwh_sum`);
  return { extracted: ins.rowCount, loaded: ins.rowCount, rejected: 0, reconciliation: rec[0] };
}

// fact_sales: рядки замовлень (CDC по sale_src_id = order_items.id)
async function etlFactSales() {
  const ins = await pool.query(`
    INSERT INTO dwh_fact_sales (sale_src_id, order_id, time_key, client_key, product_key,
        branch_id, sale_date, quantity, unit_price, total_amount, cost_amount)
    SELECT oi.id, oi.order_id,
           to_char(o.created_at,'YYYYMMDD')::int, dc.client_key, dp.product_key,
           NULL, o.created_at::date, oi.qty, oi.unit_price, oi.line_total,
           COALESCE(pv.wholesale,0) * oi.qty
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    LEFT JOIN product_variants pv ON pv.id=oi.variant_id
    LEFT JOIN dwh_dim_clients dc ON dc.client_src_id=o.client_id AND dc.is_current
    LEFT JOIN dwh_dim_products dp ON dp.product_src_id=oi.variant_id AND dp.is_current
    WHERE o.status IN ('paid','shipped','delivered')
    ON CONFLICT (sale_src_id) DO NOTHING
    RETURNING id`);
  const rec = await safeRows(`
    SELECT (SELECT COALESCE(SUM(oi.line_total),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id
              WHERE o.status IN ('paid','shipped','delivered')) AS oltp_sum,
           (SELECT COALESCE(SUM(total_amount),0) FROM dwh_fact_sales) AS dwh_sum`);
  return { extracted: ins.rowCount, loaded: ins.rowCount, rejected: 0, reconciliation: rec[0] };
}

// fact_payments: касові операції type=in (CDC по payment_src_id = cash_operations.id)
async function etlFactPayments() {
  const ins = await pool.query(`
    INSERT INTO dwh_fact_payments (payment_src_id, time_key, branch_id, payment_date,
        payment_method, category, amount)
    SELECT co.id, to_char(co.created_at,'YYYYMMDD')::int, cs.branch_id,
           co.created_at::date, co.method, co.category, co.amount
    FROM cash_operations co
    LEFT JOIN cash_shifts cs ON cs.id=co.shift_id
    WHERE co.type='in'
    ON CONFLICT (payment_src_id) DO NOTHING
    RETURNING id`);
  const rec = await safeRows(`
    SELECT (SELECT COALESCE(SUM(amount),0) FROM cash_operations WHERE type='in') AS oltp_sum,
           (SELECT COALESCE(SUM(amount),0) FROM dwh_fact_payments) AS dwh_sum`);
  return { extracted: ins.rowCount, loaded: ins.rowCount, rejected: 0, reconciliation: rec[0] };
}

// fact_staff_payroll: нарахування ЗП (CDC по payroll_src_id). master_id у OLTP = TEXT.
async function etlFactPayroll() {
  const ins = await pool.query(`
    INSERT INTO dwh_fact_staff_payroll (payroll_src_id, time_key, staff_key, period_date,
        base_salary, commission, bonus, deductions, visits_count)
    SELECT pr.id, to_char(pr.period_start,'YYYYMMDD')::int, ds.staff_key, pr.period_start,
           pr.fixed_part, pr.percent_part, pr.bonus, pr.deduction, pr.services_count
    FROM payroll_records pr
    LEFT JOIN dwh_dim_staff ds ON ds.staff_src_id = NULLIF(pr.master_id,'')::int AND ds.is_current
    WHERE pr.status IN ('approved','paid')
    ON CONFLICT (payroll_src_id) DO NOTHING
    RETURNING id`);
  return { extracted: ins.rowCount, loaded: ins.rowCount, rejected: 0 };
}

// Реєстр пайплайнів за target_table (з реєстру dwh_etl_jobs)
const PIPELINES = {
  dwh_dim_time: etlDimTime,
  dwh_dim_clients: etlDimClients,
  dwh_dim_services: etlDimServices,
  dwh_dim_staff: etlDimStaff,
  dwh_dim_products: etlDimProducts,
  dwh_fact_visits_v2: etlFactVisits,
  dwh_fact_sales: etlFactSales,
  dwh_fact_payments: etlFactPayments,
  dwh_fact_staff_payroll: etlFactPayroll,
};

// quality-score: 100 − (rejected/extracted)*100, з поправкою на reconciliation diff
function qualityScore(res) {
  let score = 100;
  const total = num(res.extracted);
  if (total > 0 && num(res.rejected) > 0) score -= (num(res.rejected) / total) * 100;
  if (res.reconciliation) {
    const o = num(res.reconciliation.oltp_sum), d = num(res.reconciliation.dwh_sum);
    if (o > 0) { const diff = Math.abs(o - d) / o * 100; score -= Math.min(diff, 20); }
  }
  return Math.max(0, Math.round(score * 100) / 100);
}

// Запуск одного ETL-джоба: лог running → виконання → completed/failed
async function runJob(job, trigger = 'manual') {
  const fn = PIPELINES[job.target_table];
  const log = await pool.query(
    `INSERT INTO dwh_etl_logs (job_id, status, trigger_kind) VALUES ($1,'running',$2) RETURNING id`,
    [job.id, trigger]);
  const logId = log.rows[0].id;
  if (!fn) {
    await pool.query(`UPDATE dwh_etl_logs SET status='skipped', completed_at=now(),
      error_message=$1 WHERE id=$2`, ['no pipeline for target ' + job.target_table, logId]);
    await pool.query(`UPDATE dwh_etl_jobs SET last_run_at=now(), last_status='skipped', updated_at=now() WHERE id=$1`, [job.id]);
    return { log_id: logId, status: 'skipped' };
  }
  try {
    const r = await fn();
    const qs = qualityScore(r);
    const rec = r.reconciliation ? {
      oltp_sum: num(r.reconciliation.oltp_sum), dwh_sum: num(r.reconciliation.dwh_sum),
      diff_pct: num(r.reconciliation.oltp_sum) > 0
        ? Math.round(Math.abs(num(r.reconciliation.oltp_sum) - num(r.reconciliation.dwh_sum)) / num(r.reconciliation.oltp_sum) * 10000) / 100
        : 0,
    } : null;
    await pool.query(
      `UPDATE dwh_etl_logs SET status='completed', rows_extracted=$1, rows_transformed=$2,
         rows_loaded=$3, rows_rejected=$4, quality_score=$5, reconciliation=$6, completed_at=now()
       WHERE id=$7`,
      [r.extracted, r.loaded, r.loaded, r.rejected, qs, rec ? JSON.stringify(rec) : null, logId]);
    await pool.query(`UPDATE dwh_etl_jobs SET last_run_at=now(), last_status='completed', updated_at=now() WHERE id=$1`, [job.id]);
    return { log_id: logId, status: 'completed', rows_loaded: r.loaded, quality_score: qs, reconciliation: rec };
  } catch (e) {
    await pool.query(`UPDATE dwh_etl_logs SET status='failed', error_message=$1, completed_at=now() WHERE id=$2`,
      [String(e.message).slice(0, 500), logId]);
    await pool.query(`UPDATE dwh_etl_jobs SET last_run_at=now(), last_status='failed', updated_at=now() WHERE id=$1`, [job.id]);
    return { log_id: logId, status: 'failed', error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
//  5.1 ETL JOBS
// ════════════════════════════════════════════════════════════════════

router.get('/etl/jobs', READ, async (req, res) => {
  try {
    const rows = await safeRows(`SELECT * FROM dwh_etl_jobs ORDER BY priority, name`);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.post('/etl/jobs', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.target_table) return res.status(400).json({ error: 'name and target_table required' });
    const row = (await pool.query(
      `INSERT INTO dwh_etl_jobs (name, description, job_type, source_table, target_table,
          cron_expression, priority, depends_on, config, is_active)
       VALUES ($1,$2,COALESCE($3,'incremental'),$4,$5,COALESCE($6,'*/15 * * * *'),
               COALESCE($7,5),COALESCE($8::int[],'{}'),COALESCE($9::jsonb,'{}'),COALESCE($10,TRUE))
       ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, job_type=EXCLUDED.job_type,
          source_table=EXCLUDED.source_table, target_table=EXCLUDED.target_table,
          cron_expression=EXCLUDED.cron_expression, priority=EXCLUDED.priority,
          depends_on=EXCLUDED.depends_on, config=EXCLUDED.config, updated_at=now()
       RETURNING *`,
      [b.name, b.description || null, b.job_type, b.source_table || null, b.target_table,
       b.cron_expression, b.priority, Array.isArray(b.depends_on) ? b.depends_on : null,
       b.config != null ? JSON.stringify(b.config) : null, b.is_active])).rows[0];
    await logAction({ user: req.user, action: 'dwh.etl.job.create', entity: 'dwh_etl_jobs', entity_id: row.id, ip: req.ip });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.get('/etl/jobs/:id(\\d+)', READ, async (req, res) => {
  try {
    const j = await safeRows(`SELECT * FROM dwh_etl_jobs WHERE id=$1`, [req.params.id]);
    if (!j.length) return res.status(404).json({ error: 'not_found' });
    const recent = await safeRows(`SELECT * FROM dwh_etl_logs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 20`, [req.params.id]);
    res.json({ data: { ...j[0], recent_runs: recent } });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.put('/etl/jobs/:id(\\d+)', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await pool.query(
      `UPDATE dwh_etl_jobs SET
         description=COALESCE($2,description), job_type=COALESCE($3,job_type),
         source_table=COALESCE($4,source_table), target_table=COALESCE($5,target_table),
         cron_expression=COALESCE($6,cron_expression), priority=COALESCE($7,priority),
         depends_on=COALESCE($8::int[],depends_on), config=COALESCE($9::jsonb,config),
         is_active=COALESCE($10,is_active), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, b.description, b.job_type, b.source_table, b.target_table,
       b.cron_expression, b.priority, Array.isArray(b.depends_on) ? b.depends_on : null,
       b.config != null ? JSON.stringify(b.config) : null, b.is_active])).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.delete('/etl/jobs/:id(\\d+)', MANAGE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM dwh_etl_jobs WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'dwh.etl.job.delete', entity: 'dwh_etl_jobs', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// POST /etl/jobs/:id/run — запуск вручну. full_reload=true → очистити ціль перед загрузкою.
router.post('/etl/jobs/:id(\\d+)/run', MANAGE, async (req, res) => {
  try {
    const j = await safeRows(`SELECT * FROM dwh_etl_jobs WHERE id=$1`, [req.params.id]);
    if (!j.length) return res.status(404).json({ error: 'not_found' });
    const job = j[0];
    if (req.body && req.body.full_reload && PIPELINES[job.target_table]) {
      // повна перезагрузка: очистити цільову факт-таблицю (dim не чистимо — FK)
      if (job.target_table.startsWith('dwh_fact'))
        await pool.query(`TRUNCATE TABLE ${job.target_table} RESTART IDENTITY`).catch(() => {});
    }
    const result = await runJob(job, 'manual');
    await logAction({ user: req.user, action: 'dwh.etl.job.run', entity: 'dwh_etl_jobs', entity_id: job.id, ip: req.ip });
    res.status(202).json({ execution_id: result.log_id, status: result.status, ...result });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// POST /etl/jobs/:id/toggle — увімкнути/вимкнути джоб
router.post('/etl/jobs/:id(\\d+)/toggle', MANAGE, async (req, res) => {
  try {
    const row = (await pool.query(
      `UPDATE dwh_etl_jobs SET is_active = NOT is_active, updated_at=now() WHERE id=$1 RETURNING id, name, is_active`,
      [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// POST /etl/run-all — запустити всі активні джоби в порядку priority (dimensions→facts)
router.post('/etl/run-all', MANAGE, async (req, res) => {
  try {
    const jobs = await safeRows(`SELECT * FROM dwh_etl_jobs WHERE is_active=TRUE ORDER BY priority, name`);
    const results = [];
    for (const job of jobs) results.push({ job: job.name, ...(await runJob(job, 'manual')) });
    await logAction({ user: req.user, action: 'dwh.etl.run_all', entity: 'dwh_etl_jobs', ip: req.ip });
    res.status(202).json({ ran: results.length, results });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// ════════════════════════════════════════════════════════════════════
//  5.2 ETL LOGS
// ════════════════════════════════════════════════════════════════════

router.get('/etl/logs', READ, async (req, res) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const perPage = Math.min(Math.max(+req.query.per_page || 50, 1), 200);
    const wh = [], p = []; let i = 1;
    if (req.query.job_id) { wh.push(`l.job_id=$${i++}`); p.push(+req.query.job_id); }
    if (req.query.status) { wh.push(`l.status=$${i++}`); p.push(req.query.status); }
    if (/^\d{4}-\d{2}-\d{2}/.test(req.query.from || '')) { wh.push(`l.started_at >= $${i++}`); p.push(req.query.from); }
    if (/^\d{4}-\d{2}-\d{2}/.test(req.query.to || '')) { wh.push(`l.started_at <= $${i++}`); p.push(req.query.to); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const total = (await safeRows(`SELECT COUNT(*)::int n FROM dwh_etl_logs l ${where}`, p))[0]?.n || 0;
    const rows = await safeRows(
      `SELECT l.*, j.name AS job_name, j.target_table FROM dwh_etl_logs l
         JOIN dwh_etl_jobs j ON j.id=l.job_id ${where}
        ORDER BY l.started_at DESC LIMIT $${i++} OFFSET $${i++}`,
      [...p, perPage, (page - 1) * perPage]);
    res.json({ data: rows, meta: { total, page, per_page: perPage } });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.get('/etl/logs/stats', READ, async (req, res) => {
  try {
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '7d';
    const interval = period === '24h' ? '24 hours' : period === '30d' ? '30 days' : '7 days';
    const r = (await safeRows(`
      SELECT COUNT(*)::int AS total_runs,
             COUNT(*) FILTER (WHERE status='completed')::int AS successful,
             COUNT(*) FILTER (WHERE status='failed')::int AS failed,
             COALESCE(ROUND(AVG(duration_sec) FILTER (WHERE duration_sec IS NOT NULL),1),0) AS avg_duration_sec,
             COALESCE(SUM(rows_loaded),0)::bigint AS total_rows_loaded,
             COALESCE(ROUND(AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL),2),0) AS avg_quality_score
        FROM dwh_etl_logs WHERE started_at >= now() - INTERVAL '${interval}'`))[0] || {};
    res.json({ period, ...r });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.get('/etl/logs/:id(\\d+)', READ, async (req, res) => {
  try {
    const rows = await safeRows(
      `SELECT l.*, j.name AS job_name, j.target_table FROM dwh_etl_logs l
         JOIN dwh_etl_jobs j ON j.id=l.job_id WHERE l.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ data: rows[0] });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// ════════════════════════════════════════════════════════════════════
//  5.3 DATA SOURCES
// ════════════════════════════════════════════════════════════════════

router.get('/sources', READ, async (req, res) => {
  try { res.json({ data: await safeRows(`SELECT * FROM dwh_data_sources ORDER BY name`) }); }
  catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.post('/sources', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.source_type) return res.status(400).json({ error: 'name and source_type required' });
    const row = (await pool.query(
      `INSERT INTO dwh_data_sources (name, source_type, connection_config, is_active)
       VALUES ($1,$2,COALESCE($3::jsonb,'{}'),COALESCE($4,TRUE))
       ON CONFLICT (name) DO UPDATE SET source_type=EXCLUDED.source_type,
         connection_config=EXCLUDED.connection_config, is_active=EXCLUDED.is_active, updated_at=now()
       RETURNING *`,
      [b.name, b.source_type, b.connection_config != null ? JSON.stringify(b.connection_config) : null, b.is_active])).rows[0];
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.put('/sources/:id(\\d+)', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await pool.query(
      `UPDATE dwh_data_sources SET source_type=COALESCE($2,source_type),
         connection_config=COALESCE($3::jsonb,connection_config), is_active=COALESCE($4,is_active), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, b.source_type, b.connection_config != null ? JSON.stringify(b.connection_config) : null, b.is_active])).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.delete('/sources/:id(\\d+)', MANAGE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM dwh_data_sources WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// POST /sources/:id/test — перевірка з'єднання. main_oltp (postgresql) тестуємо реально
// (SELECT 1), зовнішні BI (bigquery/snowflake/redshift) — graceful-стаб 'unknown'.
router.post('/sources/:id(\\d+)/test', MANAGE, async (req, res) => {
  try {
    const s = (await safeRows(`SELECT * FROM dwh_data_sources WHERE id=$1`, [req.params.id]))[0];
    if (!s) return res.status(404).json({ error: 'not_found' });
    let status = 'unknown', detail = null;
    if (s.source_type === 'postgresql') {
      try { await pool.query('SELECT 1'); status = 'healthy'; }
      catch (e) { status = 'down'; detail = e.message; }
    } else {
      status = 'unknown';
      detail = `external source '${s.source_type}' not wired (graceful stub) — налаштуйте конектор`;
    }
    await pool.query(`UPDATE dwh_data_sources SET health_status=$2, last_health_check=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, status]);
    res.json({ id: s.id, name: s.name, source_type: s.source_type, health_status: status, detail });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// ════════════════════════════════════════════════════════════════════
//  5.4 DWH QUERY / SCHEMA / FRESHNESS
// ════════════════════════════════════════════════════════════════════

// whitelist DWH-таблиць, доступних для запиту/схеми
const DWH_TABLES = [
  'dwh_dim_time', 'dwh_dim_clients', 'dwh_dim_services', 'dwh_dim_staff', 'dwh_dim_products',
  'dwh_fact_visits_v2', 'dwh_fact_sales', 'dwh_fact_payments', 'dwh_fact_staff_payroll',
];

// POST /query — аналітичний запит. Тільки SELECT, тільки DWH-таблиці, авто-LIMIT, timeout.
router.post('/query', platformOnly, requirePerm('dwh.query.execute'), async (req, res) => {
  const t0 = Date.now();
  try {
    const sql = String((req.body && req.body.sql) || '').trim();
    if (!sql) return res.status(400).json({ error: 'sql required' });
    // безпека: тільки один SELECT-стейтмент, без мутацій / DDL / множинних команд
    const lowered = sql.toLowerCase().replace(/\s+/g, ' ');
    if (!/^select\b/.test(lowered))
      return res.status(400).json({ error: 'only SELECT queries allowed' });
    if (/;\s*\S/.test(sql))
      return res.status(400).json({ error: 'single statement only' });
    if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|merge)\b/.test(lowered))
      return res.status(400).json({ error: 'mutations are not allowed' });
    // блок небезпечних pg_-функцій: pg_sleep (DoS), pg_read_file/pg_ls_dir (витік ФС), lo_* (аудит v8)
    if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend)\b/.test(lowered))
      return res.status(400).json({ error: 'function not allowed' });
    // дозволяємо лише читання з DWH-таблиць (з whitelist) та pg_catalog-функцій
    const referenced = (lowered.match(/\b(?:from|join)\s+([a-z_][a-z0-9_."]*)/g) || [])
      .map(m => m.replace(/\b(?:from|join)\s+/, '').replace(/["]/g, '').split('.').pop());
    const bad = referenced.filter(t => t && !DWH_TABLES.includes(t));
    if (bad.length) return res.status(400).json({ error: 'table not allowed', tables: bad, allowed: DWH_TABLES });

    const limit = Math.min(Math.max(+(req.body.limit) || 1000, 1), 10000);
    const timeoutSec = Math.min(Math.max(+(req.body.timeout_sec) || 30, 1), 60);
    const wrapped = `SELECT * FROM (${sql}) AS _q LIMIT ${limit}`;

    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = ${timeoutSec * 1000}`);
      const r = await client.query(wrapped, Array.isArray(req.body.params) ? req.body.params : []);
      const columns = r.fields.map(f => ({ name: f.name, type_oid: f.dataTypeID }));
      res.json({
        columns, rows: r.rows, row_count: r.rowCount,
        execution_time_ms: Date.now() - t0,
      });
    } finally { client.release(); }
  } catch (e) { res.status(400).json({ error: errOut(e), execution_time_ms: Date.now() - t0 }); }
});

// GET /schema — список DWH-таблиць з кількістю колонок/рядків
router.get('/schema', READ, async (req, res) => {
  try {
    const rows = await safeRows(`
      SELECT t.table_name,
             (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name=t.table_name)::int AS columns,
             CASE WHEN t.table_name LIKE '%fact%' THEN 'fact'
                  WHEN t.table_name LIKE '%dim%' THEN 'dimension' ELSE 'other' END AS kind
      FROM information_schema.tables t
      WHERE t.table_schema='public' AND t.table_name = ANY($1::text[])
      ORDER BY kind DESC, t.table_name`, [DWH_TABLES]);
    res.json({ schema: 'dwh', tables: rows });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// GET /schema/:table — колонки конкретної DWH-таблиці
router.get('/schema/:table', READ, async (req, res) => {
  try {
    const table = String(req.params.table);
    if (!DWH_TABLES.includes(table)) return res.status(404).json({ error: 'table not allowed', allowed: DWH_TABLES });
    const cols = await safeRows(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table]);
    const cnt = (await safeRows(`SELECT COUNT(*)::int n FROM ${table}`))[0]?.n || 0;
    res.json({ table, columns: cols, rows_count: cnt });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// GET /freshness — свежесть даних по DWH-таблицях (last loaded + статус)
router.get('/freshness', READ, async (req, res) => {
  try {
    const out = [];
    for (const t of DWH_TABLES) {
      const hasLoaded = !t.startsWith('dwh_dim_time'); // dim_time без loaded_at
      const col = t.startsWith('dwh_dim') ? 'valid_from' : 'loaded_at';
      const sql = hasLoaded
        ? `SELECT COUNT(*)::int AS rows, MAX(${col}) AS last_updated FROM ${t}`
        : `SELECT COUNT(*)::int AS rows, NULL::timestamptz AS last_updated FROM ${t}`;
      const r = (await safeRows(sql))[0] || { rows: 0, last_updated: null };
      let freshness = 'stale';
      if (r.last_updated) {
        const ageMin = (Date.now() - new Date(r.last_updated).getTime()) / 60000;
        freshness = ageMin < 15 ? 'fresh' : ageMin < 60 ? 'aging' : 'stale';
      } else if (r.rows > 0) freshness = 'static';
      out.push({ name: t, last_updated: r.last_updated, rows_count: r.rows, freshness_status: freshness });
    }
    res.json({ tables: out });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// ════════════════════════════════════════════════════════════════════
//  5.5 MATERIALIZED VIEWS (предрассчитані агрегати поверх фактів)
//  Прагматично: «views» = логічні агрегати, що рахуються з факт-таблиць.
//  refresh = пересчёт відповідної факт-таблиці через ETL.
// ════════════════════════════════════════════════════════════════════

const MVIEWS = {
  mv_daily_revenue: {
    label: 'Виручка по днях/послугах',
    source: 'dwh_fact_visits_v2',
    sql: `SELECT visit_date, COUNT(*)::int AS visits, SUM(revenue)::numeric AS revenue,
                 CASE WHEN COUNT(*)>0 THEN ROUND(SUM(revenue)/COUNT(*),2) ELSE 0 END AS avg_check
          FROM dwh_fact_visits_v2 GROUP BY visit_date ORDER BY visit_date DESC LIMIT 365`,
  },
  mv_client_lifetime_value: {
    label: 'CLV по клієнтах',
    source: 'dwh_fact_visits_v2',
    sql: `SELECT dc.client_src_id, dc.full_name, dc.segment,
                 COUNT(f.id)::int AS visits, SUM(f.revenue)::numeric AS lifetime_value
          FROM dwh_fact_visits_v2 f JOIN dwh_dim_clients dc ON dc.client_key=f.client_key
          GROUP BY dc.client_src_id, dc.full_name, dc.segment ORDER BY lifetime_value DESC LIMIT 500`,
  },
  mv_master_performance: {
    label: 'KPI майстрів',
    source: 'dwh_fact_visits_v2',
    sql: `SELECT ds.staff_src_id, ds.full_name, COUNT(f.id)::int AS visits,
                 SUM(f.revenue)::numeric AS revenue,
                 CASE WHEN COUNT(*)>0 THEN ROUND(SUM(f.revenue)/COUNT(*),2) ELSE 0 END AS avg_check,
                 COUNT(*) FILTER (WHERE f.status='no_show')::int AS no_shows
          FROM dwh_fact_visits_v2 f JOIN dwh_dim_staff ds ON ds.staff_key=f.staff_key
          GROUP BY ds.staff_src_id, ds.full_name ORDER BY revenue DESC`,
  },
  mv_service_popularity: {
    label: 'Популярність послуг',
    source: 'dwh_fact_visits_v2',
    sql: `SELECT dsv.name, dsv.category, COUNT(f.id)::int AS visits, SUM(f.revenue)::numeric AS revenue
          FROM dwh_fact_visits_v2 f JOIN dwh_dim_services dsv ON dsv.service_key=f.service_key
          GROUP BY dsv.name, dsv.category ORDER BY visits DESC LIMIT 100`,
  },
  mv_retention_cohorts: {
    label: 'Когортний аналіз утримання',
    source: 'dwh_fact_visits_v2',
    sql: `WITH first_visit AS (
            SELECT client_key, MIN(visit_date) AS cohort_date FROM dwh_fact_visits_v2 GROUP BY client_key)
          SELECT to_char(fv.cohort_date,'YYYY-MM') AS cohort,
                 COUNT(DISTINCT fv.client_key)::int AS clients,
                 COUNT(f.id)::int AS total_visits
          FROM first_visit fv JOIN dwh_fact_visits_v2 f ON f.client_key=fv.client_key
          GROUP BY 1 ORDER BY 1 DESC LIMIT 36`,
  },
};

router.get('/views', READ, async (req, res) => {
  res.json({ data: Object.entries(MVIEWS).map(([name, v]) => ({ name, label: v.label, source: v.source })) });
});

// GET /views/:name — дані вітрини (агрегат)
router.get('/views/:name', READ, async (req, res) => {
  try {
    const v = MVIEWS[req.params.name];
    if (!v) return res.status(404).json({ error: 'view not found', allowed: Object.keys(MVIEWS) });
    const rows = await safeRows(v.sql);
    res.json({ name: req.params.name, label: v.label, rows });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// GET /views/:name/stats — мета-статистика вітрини
router.get('/views/:name/stats', READ, async (req, res) => {
  try {
    const v = MVIEWS[req.params.name];
    if (!v) return res.status(404).json({ error: 'view not found', allowed: Object.keys(MVIEWS) });
    const t0 = Date.now();
    const rows = await safeRows(v.sql);
    const last = (await safeRows(`SELECT MAX(loaded_at) AS t FROM ${v.source}`))[0];
    res.json({ name: req.params.name, source: v.source, row_count: rows.length,
      compute_time_ms: Date.now() - t0, source_last_loaded: last ? last.t : null });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// POST /views/:name/refresh — пересчёт (запускає ETL джерела вітрини)
router.post('/views/:name/refresh', MANAGE, async (req, res) => {
  try {
    const v = MVIEWS[req.params.name];
    if (!v) return res.status(404).json({ error: 'view not found', allowed: Object.keys(MVIEWS) });
    const job = (await safeRows(`SELECT * FROM dwh_etl_jobs WHERE target_table=$1 LIMIT 1`, [v.source]))[0];
    if (job) await runJob(job, 'manual');
    res.status(202).json({ status: 'refreshing', view: req.params.name, source: v.source, estimated_time_sec: 2 });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// ════════════════════════════════════════════════════════════════════
//  LEGACY (backward-compat поверх dwh_fact_visits/dwh_etl_runs з міграції 116)
// ════════════════════════════════════════════════════════════════════

const LEGACY_DIMS = {
  master: 'master_name', service: 'service_name', category: 'service_category',
  source: 'source', status: 'status',
  day: "to_char(visit_date,'YYYY-MM-DD')", month: "to_char(visit_date,'YYYY-MM')",
};

router.get('/status', READ, async (req, res) => {
  try {
    const f = await safeRows(
      `SELECT COUNT(*)::int AS rows, COALESCE(MIN(visit_date)::text,'') AS min_date,
              COALESCE(MAX(visit_date)::text,'') AS max_date, COALESCE(SUM(revenue),0) AS revenue
       FROM dwh_fact_visits`, [], [{ rows: 0, min_date: '', max_date: '', revenue: 0 }]);
    const last = await safeRows(
      `SELECT status, rows_loaded, finished_at FROM dwh_etl_runs
       WHERE pipeline='fact_visits' ORDER BY started_at DESC LIMIT 1`);
    // зведення star-schema v2
    const v2 = await safeRows(`
      SELECT (SELECT COUNT(*) FROM dwh_fact_visits_v2)::int AS fact_visits,
             (SELECT COUNT(*) FROM dwh_fact_sales)::int AS fact_sales,
             (SELECT COUNT(*) FROM dwh_fact_payments)::int AS fact_payments,
             (SELECT COUNT(*) FROM dwh_fact_staff_payroll)::int AS fact_payroll,
             (SELECT COUNT(*) FROM dwh_dim_clients WHERE is_current)::int AS dim_clients`,
      [], [{}]);
    res.json({ fact_visits: f[0], last_etl: last[0] || null, dwh_v2: v2[0] });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.post('/etl', MANAGE, async (req, res) => {
  const t0 = Date.now();
  let runId = null;
  try {
    const run = await pool.query(
      `INSERT INTO dwh_etl_runs (pipeline,status) VALUES ('fact_visits','running') RETURNING id`);
    runId = run.rows[0].id;
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
    const dq = await pool.query(`SELECT COUNT(*)::int AS n FROM dwh_fact_visits WHERE revenue <= 0`);
    const dur = Date.now() - t0;
    const r = await pool.query(
      `UPDATE dwh_etl_runs SET status='success', rows_loaded=$1, quality_issues=$2, duration_ms=$3, finished_at=NOW()
       WHERE id=$4 RETURNING *`,
      [ins.rowCount, dq.rows[0].n, dur, runId]);
    await logAction({ user: req.user, action: 'dwh.etl', entity: 'dwh_etl_runs', entity_id: runId, ip: req.ip });
    res.status(201).json({ ...r.rows[0], note: `Загружено ${ins.rowCount} новых визитов за ${dur} мс.` });
  } catch (e) {
    if (runId) await pool.query(`UPDATE dwh_etl_runs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
      [String(e.message).slice(0, 300), runId]).catch(() => {});
    res.status(500).json({ error: errOut(e) });
  }
});

router.get('/etl-runs', READ, async (req, res) => {
  try { res.json(await safeRows(`SELECT * FROM dwh_etl_runs ORDER BY started_at DESC LIMIT 100`)); }
  catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.get('/quality', READ, async (req, res) => {
  try {
    const r = await safeRows(`
      SELECT COUNT(*)::int AS total_rows,
        COUNT(*) FILTER (WHERE revenue <= 0)::int AS zero_revenue,
        COUNT(*) FILTER (WHERE master_name='—')::int AS missing_master,
        COUNT(*) FILTER (WHERE service_name='—')::int AS missing_service,
        COUNT(*) FILTER (WHERE visit_date IS NULL)::int AS missing_date
      FROM dwh_fact_visits`, [], [{}]);
    res.json(r[0]);
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

router.get('/facts', READ, async (req, res) => {
  try {
    const dimKey = String(req.query.dim || 'month');
    const dimSql = LEGACY_DIMS[dimKey];
    if (!dimSql) return res.status(400).json({ error: 'bad_dim', allowed: Object.keys(LEGACY_DIMS) });
    const where = [], vals = []; let i = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push(`visit_date >= $${i++}`); vals.push(req.query.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push(`visit_date <= $${i++}`); vals.push(req.query.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await safeRows(
      `SELECT ${dimSql} AS dimension, SUM(visits)::int AS visits, COALESCE(SUM(revenue),0) AS revenue,
              CASE WHEN SUM(visits)>0 THEN ROUND(SUM(revenue)/SUM(visits),2) ELSE 0 END AS avg_check
       FROM dwh_fact_visits ${w}
       GROUP BY ${dimSql} ORDER BY revenue DESC LIMIT 500`, vals);
    res.json({ dim: dimKey, rows: r });
  } catch (e) { res.status(500).json({ error: errOut(e) }); }
});

// Нічний авто-ETL (shop-api.js): всі активні джоби у порядку priority
async function runAllActive(trigger = 'cron') {
  const jobs = await safeRows(`SELECT * FROM dwh_etl_jobs WHERE is_active=TRUE ORDER BY priority, name`);
  const results = [];
  for (const job of jobs) results.push({ job: job.name, ...(await runJob(job, trigger)) });
  return results;
}

module.exports = router;
module.exports.runAllActive = runAllActive;
