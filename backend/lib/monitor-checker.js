/* INF-04 Monitoring — checker.
 * Выполняет health-проверки (HTTP + БД), пишет историю uptime, оценивает пороговые
 * правила алертов по встроенным метрикам и при firing шлёт уведомление (best-effort)
 * и опционально создаёт инцидент MGT-04. Работает как in-process интервал — без
 * внешних агентов (Prometheus/Loki не нужны для текущего масштаба).
 */
const { getPool } = require('../db-pg');
const { runAs, DEFAULT_TENANT_ID } = require('./tenant');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const SLA_MIN = { critical: [15, 120], high: [60, 480], medium: [240, 1440], low: [1440, 4320] };
let timer = null;

// ── одиночная HTTP-проверка с таймаутом ──
async function pingHttp(url, expected, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'svs-monitor/1.0' } });
    const ms = Date.now() - t0;
    if (expected && r.status !== expected) return { status: 'degraded', ms, error: `HTTP ${r.status} (ожидался ${expected})` };
    return { status: 'up', ms, error: null };
  } catch (e) {
    return { status: 'down', ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// ── проверка БД ──
async function pingDb(timeoutMs) {
  const t0 = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { status: 'up', ms: Date.now() - t0, error: null };
  } catch (e) {
    return { status: 'down', ms: Date.now() - t0, error: e.message };
  }
}

// ── выполнить ВСЕ активные проверки ──
async function runChecks() {
  const checks = await q(`SELECT * FROM health_checks WHERE is_active=TRUE`);
  for (const c of checks) {
    const res = c.check_type === 'db'
      ? await pingDb(c.timeout_ms)
      : await pingHttp(c.endpoint, c.expected_status, c.timeout_ms);
    const fails = res.status === 'up' ? 0 : (c.consecutive_failures + 1);
    await q(
      `UPDATE health_checks SET last_status=$1, last_response_ms=$2, last_checked_at=NOW(),
         last_error=$3, consecutive_failures=$4, updated_at=NOW() WHERE id=$5`,
      [res.status, res.ms, res.error, fails, c.id]);
    await q(
      `INSERT INTO uptime_records (health_check_id, status, response_time_ms, error_message)
       VALUES ($1,$2,$3,$4)`, [c.id, res.status, res.ms, res.error]);
  }
  return checks.length;
}

// ── вычислить встроенную метрику ──
async function computeMetric(key, service) {
  const svcFilter = service ? `AND service_name=$1` : '';
  const args = service ? [service] : [];
  switch (key) {
    case 'service_down': {
      const r = (await q(`SELECT COUNT(*)::int n FROM health_checks WHERE is_active=TRUE AND last_status='down' ${svcFilter}`, args))[0];
      return r.n > 0 ? 1 : 0;
    }
    case 'consecutive_failures': {
      const r = (await q(`SELECT COALESCE(MAX(consecutive_failures),0)::int n FROM health_checks WHERE is_active=TRUE ${svcFilter}`, args))[0];
      return r.n;
    }
    case 'db_latency_ms': {
      const r = (await q(`SELECT COALESCE(last_response_ms,0)::int n FROM health_checks WHERE service_name='database' LIMIT 1`))[0];
      return r ? r.n : 0;
    }
    case 'error_rate': { // % проверок down за последний час
      const r = (await q(
        `SELECT COALESCE(ROUND(100.0*COUNT(*) FILTER (WHERE u.status='down')/NULLIF(COUNT(*),0),2),0)::numeric n
         FROM uptime_records u JOIN health_checks h ON h.id=u.health_check_id
         WHERE u.checked_at > NOW()-INTERVAL '1 hour' ${service ? 'AND h.service_name=$1' : ''}`, args))[0];
      return Number(r.n);
    }
    case 'uptime_24h': {
      const r = (await q(
        `SELECT COALESCE(ROUND(100.0*COUNT(*) FILTER (WHERE u.status='up')/NULLIF(COUNT(*),0),2),100)::numeric n
         FROM uptime_records u JOIN health_checks h ON h.id=u.health_check_id
         WHERE u.checked_at > NOW()-INTERVAL '24 hours' ${service ? 'AND h.service_name=$1' : ''}`, args))[0];
      return Number(r.n);
    }
    default: return 0;
  }
}

function compare(v, op, t) {
  switch (op) {
    case '>': return v > t; case '>=': return v >= t;
    case '<': return v < t; case '<=': return v <= t;
    case '==': return v === t; default: return false;
  }
}

// ── best-effort уведомление в Telegram ──
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_NOTIFY_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.OWNER_CHAT_ID;
  if (!token || !chat) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
    return true;
  } catch (_) { return false; }
}

// ── авто-инцидент MGT-04 (в контексте дефолтного тенанта) ──
async function autoIncident(rule, value) {
  return runAs(DEFAULT_TENANT_ID, async () => {
    const pr = ['critical', 'high', 'medium', 'low'].includes(rule.severity)
      ? (rule.severity === 'emergency' ? 'critical' : rule.severity) : 'high';
    const [respMin, resolMin] = SLA_MIN[pr] || SLA_MIN.high;
    const year = new Date().getFullYear();
    const prefix = `INC-${year}-`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const mx = (await q(
          `SELECT COALESCE(MAX(CAST(split_part(incident_number,'-',3) AS INTEGER)),0) mx
           FROM incidents WHERE tenant_id=current_tenant_id() AND incident_number LIKE $1`, [prefix + '%']))[0].mx;
        const num = prefix + String(mx + 1).padStart(4, '0');
        const ins = await q(
          `INSERT INTO incidents (incident_number, title, description, incident_type, priority,
             status, source, sla_first_response_at, sla_resolution_at)
           VALUES ($1,$2,$3,'it',$4,'open','auto',
             NOW()+($5||' minutes')::interval, NOW()+($6||' minutes')::interval) RETURNING id`,
          [num, `[MONITOR] ${rule.name}`,
           `Авто-інцидент від моніторингу. Правило: ${rule.name} (${rule.metric_key} ${rule.comparator} ${rule.threshold}). Значення: ${value}.`,
           pr, String(respMin), String(resolMin)]);
        return ins[0].id;
      } catch (e) {
        if (String(e.message).includes('ux_incidents_number')) continue;
        return null;
      }
    }
    return null;
  });
}

// ── оценить все правила ──
async function evaluateAlerts() {
  const rules = await q(`SELECT * FROM alert_rules WHERE is_active=TRUE`);
  for (const r of rules) {
    let value;
    try { value = await computeMetric(r.metric_key, r.service_name); }
    catch (_) { continue; }
    const breached = compare(Number(value), r.comparator, Number(r.threshold));
    const open = (await q(`SELECT * FROM alert_history WHERE rule_id=$1 AND status='firing' ORDER BY fired_at DESC LIMIT 1`, [r.id]))[0];

    if (breached) {
      const streak = r.breach_streak + 1;
      await q(`UPDATE alert_rules SET breach_streak=$1, updated_at=NOW() WHERE id=$2`, [streak, r.id]);
      if (streak >= r.for_consecutive && !open) {
        const msg = `${r.name}: ${r.metric_key}${r.service_name ? '(' + r.service_name + ')' : ''} = ${value} ${r.comparator} ${r.threshold}`;
        const ah = (await q(
          `INSERT INTO alert_history (rule_id, status, severity, service_name, value, message, fired_at)
           VALUES ($1,'firing',$2,$3,$4,$5,NOW()) RETURNING id`,
          [r.id, r.severity, r.service_name, value, msg]))[0];
        let incId = null;
        if (r.auto_incident && (r.severity === 'critical' || r.severity === 'emergency')) {
          incId = await autoIncident(r, value).catch(() => null);
        }
        let sent = false;
        if ((r.notify_channels || []).includes('telegram')) {
          sent = await notifyTelegram(`🔴 <b>Моніторинг: ${r.severity.toUpperCase()}</b>\n${msg}${incId ? `\nСтворено інцидент #${incId}` : ''}`);
        }
        await q(`UPDATE alert_history SET incident_id=$1, notification_sent=$2 WHERE id=$3`, [incId, sent, ah.id]);
      }
    } else {
      if (r.breach_streak !== 0) await q(`UPDATE alert_rules SET breach_streak=0, updated_at=NOW() WHERE id=$1`, [r.id]);
      if (open) {
        await q(`UPDATE alert_history SET status='resolved', resolved_at=NOW() WHERE id=$1`, [open.id]);
        if ((r.notify_channels || []).includes('telegram')) {
          await notifyTelegram(`🟢 <b>Моніторинг: відновлено</b>\n${r.name} — значення повернулось у норму (${value}).`);
        }
      }
    }
  }
}

// ── прунинг старых записей (раз в сутки достаточно) ──
let lastPrune = 0;
async function maybePrune() {
  if (Date.now() - lastPrune < 6 * 3600 * 1000) return;
  lastPrune = Date.now();
  await q(`DELETE FROM uptime_records WHERE checked_at < NOW()-INTERVAL '90 days'`).catch(() => {});
  await q(`DELETE FROM alert_history WHERE status='resolved' AND resolved_at < NOW()-INTERVAL '90 days'`).catch(() => {});
}

async function tick() {
  try {
    await runChecks();
    await evaluateAlerts();
    await maybePrune();
  } catch (e) {
    console.error('[monitor] tick error:', e.message);
  }
}

function start(intervalMs = 60000) {
  if (timer) return;
  // первый прогон через 20с после старта (даём сервису подняться)
  setTimeout(tick, 20000);
  timer = setInterval(tick, intervalMs);
  console.log(`[monitor] checker started (interval ${intervalMs}ms)`);
}

module.exports = { start, runChecks, evaluateAlerts, tick };
