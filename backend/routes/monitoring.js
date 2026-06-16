/* ═══════════════════════════════════════════════════════
   INF-04 Monitoring — /api/monitoring
   Прагматичная наблюдаемость без Prometheus/Loki/Jaeger:
   health checks (HTTP + БД), uptime/SLA, пороговые алерты, авто-инцидент MGT-04.
   Права: monitoring.read (GET) / monitoring.manage (мутации).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const checker = require('../lib/monitor-checker');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const err = (res, e) => { console.error('[monitoring]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };

router.use((req, res, next) => requirePerm(req.method === 'GET' ? 'monitoring.read' : 'monitoring.manage')(req, res, next));

/* ── ОБЩЕЕ ЗДОРОВЬЕ ── */
router.get('/health', async (req, res) => {
  try {
    const checks = await q(`SELECT service_name, check_type, last_status, last_response_ms, last_checked_at, consecutive_failures, last_error
                            FROM health_checks WHERE is_active=TRUE ORDER BY service_name`);
    const up = (await q(
      `SELECT COALESCE(ROUND(100.0*COUNT(*) FILTER (WHERE status='up')/NULLIF(COUNT(*),0),2),100)::numeric n
       FROM uptime_records WHERE checked_at > NOW()-INTERVAL '24 hours'`))[0].n;
    const anyDown = checks.some(c => c.last_status === 'down');
    const anyDeg = checks.some(c => c.last_status === 'degraded');
    const active = (await q(`SELECT COUNT(*)::int n FROM alert_history WHERE status='firing'`))[0].n;
    res.json({
      status: anyDown ? 'down' : (anyDeg ? 'degraded' : 'healthy'),
      uptime_24h: Number(up), active_alerts: active,
      services: checks.map(c => ({
        name: c.service_name, type: c.check_type, status: c.last_status,
        response_time_ms: c.last_response_ms, last_checked: c.last_checked_at,
        consecutive_failures: c.consecutive_failures, last_error: c.last_error,
      })),
    });
  } catch (e) { err(res, e); }
});

router.get('/health/:service', async (req, res) => {
  try {
    const c = (await q(`SELECT * FROM health_checks WHERE service_name=$1 LIMIT 1`, [req.params.service]))[0];
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(c);
  } catch (e) { err(res, e); }
});

/* ── HEALTH CHECKS CRUD ── */
router.get('/health-checks', async (req, res) => {
  try { res.json({ rows: await q(`SELECT * FROM health_checks ORDER BY service_name`) }); }
  catch (e) { err(res, e); }
});

router.post('/health-checks', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.service_name || !b.endpoint) return res.status(400).json({ error: 'service_name_and_endpoint_required' });
    const row = (await q(
      `INSERT INTO health_checks (service_name, check_type, endpoint, interval_sec, timeout_ms, expected_status, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (service_name, endpoint) DO UPDATE SET check_type=EXCLUDED.check_type,
         interval_sec=EXCLUDED.interval_sec, timeout_ms=EXCLUDED.timeout_ms,
         expected_status=EXCLUDED.expected_status, is_active=EXCLUDED.is_active, updated_at=NOW()
       RETURNING *`,
      [b.service_name, b.check_type || 'http', b.endpoint, b.interval_sec || 60,
       b.timeout_ms || 8000, b.expected_status ?? 200, b.is_active !== false]))[0];
    logAction({ user: req.user, action: 'monitoring.healthcheck_upsert', entity: 'health_checks', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.json(row);
  } catch (e) { err(res, e); }
});

router.put('/health-checks/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await q(
      `UPDATE health_checks SET
         interval_sec=COALESCE($1,interval_sec), timeout_ms=COALESCE($2,timeout_ms),
         expected_status=COALESCE($3,expected_status), is_active=COALESCE($4,is_active), updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [b.interval_sec ?? null, b.timeout_ms ?? null, b.expected_status ?? null,
       b.is_active ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { err(res, e); }
});

router.delete('/health-checks/:id', async (req, res) => {
  try {
    await q(`DELETE FROM health_checks WHERE id=$1`, [req.params.id]);
    logAction({ user: req.user, action: 'monitoring.healthcheck_delete', entity: 'health_checks', entity_id: req.params.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

// Прогнать проверки прямо сейчас (ручной триггер).
router.post('/run', async (req, res) => {
  try { const n = await checker.runChecks(); await checker.evaluateAlerts(); res.json({ ok: true, checked: n }); }
  catch (e) { err(res, e); }
});

/* ── UPTIME / SLA ── */
router.get('/uptime/summary', async (req, res) => {
  try {
    const rows = await q(
      `SELECT h.service_name,
         COALESCE(ROUND(100.0*COUNT(*) FILTER (WHERE u.status='up')/NULLIF(COUNT(*),0),3),100) uptime_24h,
         ROUND(AVG(u.response_time_ms) FILTER (WHERE u.status='up'))::int avg_response_ms,
         COUNT(*)::int checks
       FROM health_checks h LEFT JOIN uptime_records u
         ON u.health_check_id=h.id AND u.checked_at > NOW()-INTERVAL '24 hours'
       WHERE h.is_active=TRUE GROUP BY h.service_name ORDER BY h.service_name`);
    res.json({ rows });
  } catch (e) { err(res, e); }
});

router.get('/uptime/:service', async (req, res) => {
  try {
    const map = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
    const win = map[req.query.period] || '24 hours';
    const c = (await q(`SELECT id FROM health_checks WHERE service_name=$1 LIMIT 1`, [req.params.service]))[0];
    if (!c) return res.status(404).json({ error: 'not_found' });
    const r = (await q(
      `SELECT COUNT(*)::int total,
         COUNT(*) FILTER (WHERE status='up')::int up,
         ROUND(AVG(response_time_ms) FILTER (WHERE status='up'))::int avg_response_ms
       FROM uptime_records WHERE health_check_id=$1 AND checked_at > NOW()-INTERVAL '${win}'`, [c.id]))[0];
    const pct = r.total ? Math.round((r.up / r.total) * 10000) / 100 : 100;
    res.json({ service: req.params.service, period: req.query.period || '24h',
      uptime_percent: pct, total_checks: r.total, successful_checks: r.up, avg_response_ms: r.avg_response_ms });
  } catch (e) { err(res, e); }
});

router.get('/sla', async (req, res) => {
  try { res.json({ rows: await q(`SELECT * FROM sla_configs ORDER BY name`) }); }
  catch (e) { err(res, e); }
});

router.post('/sla', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    const row = (await q(
      `INSERT INTO sla_configs (name, target_uptime, measurement_window, services, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.name, b.target_uptime || 99.9, b.measurement_window || 'monthly',
       b.services || [], b.is_active !== false]))[0];
    res.json(row);
  } catch (e) { err(res, e); }
});

router.put('/sla/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await q(
      `UPDATE sla_configs SET name=COALESCE($1,name), target_uptime=COALESCE($2,target_uptime),
         measurement_window=COALESCE($3,measurement_window), services=COALESCE($4,services),
         is_active=COALESCE($5,is_active), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [b.name ?? null, b.target_uptime ?? null, b.measurement_window ?? null,
       b.services ?? null, b.is_active ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { err(res, e); }
});

router.get('/sla/:id/report', async (req, res) => {
  try {
    const sla = (await q(`SELECT * FROM sla_configs WHERE id=$1`, [req.params.id]))[0];
    if (!sla) return res.status(404).json({ error: 'not_found' });
    const winMap = { month: '30 days', quarter: '90 days', year: '365 days' };
    const win = winMap[req.query.period] || '30 days';
    const svcFilter = (sla.services && sla.services.length) ? `AND h.service_name = ANY($1)` : '';
    const args = (sla.services && sla.services.length) ? [sla.services] : [];
    const r = (await q(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE u.status='up')::int up
       FROM uptime_records u JOIN health_checks h ON h.id=u.health_check_id
       WHERE u.checked_at > NOW()-INTERVAL '${win}' ${svcFilter}`, args))[0];
    const actual = r.total ? (r.up / r.total) * 100 : 100;
    const windowMin = { '30 days': 43200, '90 days': 129600, '365 days': 525600 }[win];
    const budgetTotal = Math.round(windowMin * (1 - sla.target_uptime / 100));
    const budgetUsed = Math.round(windowMin * (1 - actual / 100));
    res.json({
      sla_target: Number(sla.target_uptime), actual_uptime: Math.round(actual * 1000) / 1000,
      error_budget_total_min: budgetTotal, error_budget_used_min: budgetUsed,
      error_budget_remaining_min: Math.max(0, budgetTotal - budgetUsed),
      breached: actual < sla.target_uptime, total_checks: r.total,
    });
  } catch (e) { err(res, e); }
});

/* ── ALERT RULES ── */
router.get('/alerts/rules', async (req, res) => {
  try { res.json({ rows: await q(`SELECT * FROM alert_rules ORDER BY severity, name`) }); }
  catch (e) { err(res, e); }
});

router.post('/alerts/rules', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.metric_key) return res.status(400).json({ error: 'name_and_metric_key_required' });
    const row = (await q(
      `INSERT INTO alert_rules (name, description, metric_key, service_name, comparator, threshold,
         for_consecutive, severity, notify_channels, auto_incident, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.description || null, b.metric_key, b.service_name || null,
       b.comparator || '>', b.threshold || 0, b.for_consecutive || 1,
       b.severity || 'warning', b.notify_channels || [], !!b.auto_incident, b.is_active !== false]))[0];
    logAction({ user: req.user, action: 'monitoring.rule_create', entity: 'alert_rules', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.json(row);
  } catch (e) { err(res, e); }
});

router.put('/alerts/rules/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await q(
      `UPDATE alert_rules SET name=COALESCE($1,name), description=COALESCE($2,description),
         metric_key=COALESCE($3,metric_key), service_name=$4, comparator=COALESCE($5,comparator),
         threshold=COALESCE($6,threshold), for_consecutive=COALESCE($7,for_consecutive),
         severity=COALESCE($8,severity), notify_channels=COALESCE($9,notify_channels),
         auto_incident=COALESCE($10,auto_incident), is_active=COALESCE($11,is_active), updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [b.name ?? null, b.description ?? null, b.metric_key ?? null, b.service_name ?? null,
       b.comparator ?? null, b.threshold ?? null, b.for_consecutive ?? null, b.severity ?? null,
       b.notify_channels ?? null, b.auto_incident ?? null, b.is_active ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { err(res, e); }
});

router.delete('/alerts/rules/:id', async (req, res) => {
  try { await q(`DELETE FROM alert_rules WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { err(res, e); }
});

/* ── ALERT HISTORY / ACTIVE ── */
router.get('/alerts/active', async (req, res) => {
  try {
    const rows = await q(
      `SELECT ah.*, ar.name rule_name, ar.metric_key FROM alert_history ah JOIN alert_rules ar ON ar.id=ah.rule_id
       WHERE ah.status='firing' AND (ah.silenced_until IS NULL OR ah.silenced_until < NOW())
       ORDER BY array_position(ARRAY['emergency','critical','warning','info'], ah.severity), ah.fired_at DESC`);
    const by = { emergency: 0, critical: 0, warning: 0, info: 0 };
    rows.forEach(r => { by[r.severity] = (by[r.severity] || 0) + 1; });
    res.json({ rows, total_firing: rows.length, by_severity: by });
  } catch (e) { err(res, e); }
});

router.get('/alerts/history', async (req, res) => {
  try {
    const w = ['1=1']; const p = [];
    if (req.query.status) { p.push(req.query.status); w.push(`ah.status=$${p.length}`); }
    if (req.query.severity) { p.push(req.query.severity); w.push(`ah.severity=$${p.length}`); }
    if (req.query.rule_id) { p.push(req.query.rule_id); w.push(`ah.rule_id=$${p.length}`); }
    const limit = Math.min(parseInt(req.query.per_page) || 50, 200);
    const rows = await q(
      `SELECT ah.*, ar.name rule_name FROM alert_history ah JOIN alert_rules ar ON ar.id=ah.rule_id
       WHERE ${w.join(' AND ')} ORDER BY ah.fired_at DESC LIMIT ${limit}`, p);
    res.json({ rows });
  } catch (e) { err(res, e); }
});

router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const row = (await q(
      `UPDATE alert_history SET acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2 RETURNING *`,
      [req.user?.id ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { err(res, e); }
});

router.post('/alerts/:id/silence', async (req, res) => {
  try {
    const minutes = parseInt(req.body?.minutes) || 60;
    const row = (await q(
      `UPDATE alert_history SET silenced_until=NOW()+($1||' minutes')::interval WHERE id=$2 RETURNING *`,
      [String(minutes), req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { err(res, e); }
});

/* ── ВСТРОЕННЫЕ МЕТРИКИ (замена Prometheus-прокси) ── */
router.get('/metrics', async (req, res) => {
  try {
    const m = {};
    const one = async (k, sql) => { try { m[k] = (await q(sql))[0]?.n ?? null; } catch (_) { m[k] = null; } };
    await one('db_size_mb', `SELECT ROUND(pg_database_size(current_database())/1048576.0,1) n`);
    await one('appointments_today', `SELECT COUNT(*)::int n FROM appointments WHERE starts_at::date=CURRENT_DATE`);
    await one('clients_total', `SELECT COUNT(*)::int n FROM clients`);
    await one('orders_today', `SELECT COUNT(*)::int n FROM orders WHERE created_at::date=CURRENT_DATE`);
    await one('active_alerts', `SELECT COUNT(*)::int n FROM alert_history WHERE status='firing'`);
    await one('db_connections', `SELECT COUNT(*)::int n FROM pg_stat_activity WHERE datname=current_database()`);
    res.json({ generated_at: new Date().toISOString(), uptime_proc_sec: Math.round(process.uptime()), metrics: m });
  } catch (e) { err(res, e); }
});

module.exports = router;
