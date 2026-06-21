/* lib/security-center.js — INF-05 Security Center.
   Доповнює наявну авторизацію (012_auth_module) підмодулями governance/threat:
   - Threat Detection: скан auth_attempts → security_events (brute-force).
   - IP whitelist для адмін-операцій.
   - Налаштовувана політика паролів (per-tenant).
   - Агрегація для Security Dashboard.
   Усе пер-тенант через RLS. Cron-скан читає глобально (raw query) і пише
   у контексті кожного тенанта через runAs (як meta-ads/google-ads). */
const { query, getPool } = require('../db-pg');

const BRUTE_WINDOW_MIN = 30;     // вікно аналізу невдалих спроб
const BRUTE_THRESHOLD = 5;        // невдач у вікні → подія

/* ── Security events ───────────────────────────────────────── */

// Записати подію безпеки (у контексті поточного тенанта). best-effort.
async function recordEvent({ user_id, event_type, severity, description, metadata, ip_address }) {
  const r = await getPool().query(
    `INSERT INTO security_events (user_id, event_type, severity, description, metadata, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, event_type, severity, created_at`,
    [user_id || null, event_type, severity || 'medium', description,
     JSON.stringify(metadata || {}), ip_address || null]);
  return r.rows[0];
}

async function listEvents({ event_type, severity, resolved, from, to, limit = 50, offset = 0 } = {}) {
  const cond = ['tenant_id = current_tenant_id()'];
  const params = [];
  const add = (sql, val) => { params.push(val); cond.push(sql.replace('?', `$${params.length}`)); };
  if (event_type) add('event_type = ?', event_type);
  if (severity) add('severity = ?', severity);
  if (resolved === 'true' || resolved === true) cond.push('resolved = TRUE');
  if (resolved === 'false' || resolved === false) cond.push('resolved = FALSE');
  if (from) add('created_at >= ?', from);
  if (to) add('created_at <= ?', to);
  const where = cond.join(' AND ');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = (await getPool().query(
    `SELECT * FROM security_events WHERE ${where} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`, params)).rows;
  const total = (await getPool().query(`SELECT count(*)::int n FROM security_events WHERE ${where}`, params)).rows[0].n;
  return { rows, total, limit: lim, offset: off };
}

async function resolveEvent(id, userId) {
  const r = await getPool().query(
    `UPDATE security_events SET resolved=TRUE, resolved_by=$2, resolved_at=now()
     WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [id, userId || null]);
  return r.rowCount > 0;
}

async function eventStats() {
  const bySeverity = (await getPool().query(
    `SELECT severity, count(*)::int n FROM security_events
       WHERE tenant_id=current_tenant_id() AND resolved=FALSE GROUP BY severity`)).rows;
  const byType = (await getPool().query(
    `SELECT event_type, count(*)::int n FROM security_events
       WHERE tenant_id=current_tenant_id() AND created_at >= now() - interval '7 days'
       GROUP BY event_type ORDER BY n DESC`)).rows;
  const open = (await getPool().query(
    `SELECT count(*)::int n FROM security_events WHERE tenant_id=current_tenant_id() AND resolved=FALSE`)).rows[0].n;
  return { open, by_severity: bySeverity, by_type: byType };
}

/* ── IP whitelist ──────────────────────────────────────────── */

async function listWhitelist() {
  return (await getPool().query(
    `SELECT * FROM ip_whitelist WHERE tenant_id=current_tenant_id() ORDER BY created_at DESC`)).rows;
}

async function addWhitelist({ ip_address, cidr_range, description, scope, expires_at, created_by }) {
  if (!ip_address && !cidr_range) throw new Error('ip_address or cidr_range required');
  const r = await getPool().query(
    `INSERT INTO ip_whitelist (ip_address, cidr_range, description, scope, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ip_address || null, cidr_range || null, description || null, scope || 'admin',
     expires_at || null, created_by || null]);
  return r.rows[0];
}

async function removeWhitelist(id) {
  const r = await getPool().query(
    `DELETE FROM ip_whitelist WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [id]);
  return r.rowCount > 0;
}

// Чи дозволений IP для scope. Якщо для тенанта немає активних правил даного scope —
// whitelist вимкнено (дозволено всім) — щоб не заблокувати салон, який не налаштував список.
async function isAllowed(ip, scope = 'admin') {
  if (!ip) return true;
  const rules = (await getPool().query(
    `SELECT ip_address, cidr_range FROM ip_whitelist
       WHERE tenant_id=current_tenant_id() AND is_active=TRUE
         AND scope IN ($1,'all') AND (expires_at IS NULL OR expires_at > now())`, [scope])).rows;
  if (rules.length === 0) return true; // whitelist не налаштований → не блокуємо
  for (const r of rules) {
    if (r.ip_address && r.ip_address === ip) return true;
    if (r.cidr_range) {
      try {
        const ok = (await getPool().query(`SELECT $1::inet <<= $2::cidr AS m`, [ip, r.cidr_range])).rows[0].m;
        if (ok) return true;
      } catch { /* битий CIDR — ігноруємо */ }
    }
  }
  return false;
}

/* ── Політика паролів ──────────────────────────────────────── */

const DEFAULT_POLICY = {
  min_length: 8, require_uppercase: true, require_lowercase: true, require_digits: true,
  require_special: false, max_age_days: 90, history_count: 5, lockout_attempts: 5,
  lockout_duration_min: 30, require_2fa: false, require_2fa_roles: ['owner', 'admin'],
};

async function getPolicy() {
  const r = (await getPool().query(
    `SELECT * FROM password_policies WHERE tenant_id=current_tenant_id() LIMIT 1`)).rows[0];
  return r || { ...DEFAULT_POLICY, is_default: true };
}

async function updatePolicy(patch = {}) {
  const cur = await getPolicy();
  const m = { ...DEFAULT_POLICY, ...cur, ...patch };
  const r = await getPool().query(
    `INSERT INTO password_policies
       (tenant_id, min_length, require_uppercase, require_lowercase, require_digits,
        require_special, max_age_days, history_count, lockout_attempts, lockout_duration_min,
        require_2fa, require_2fa_roles)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id) DO UPDATE SET
       min_length=$1, require_uppercase=$2, require_lowercase=$3, require_digits=$4,
       require_special=$5, max_age_days=$6, history_count=$7, lockout_attempts=$8,
       lockout_duration_min=$9, require_2fa=$10, require_2fa_roles=$11, updated_at=now()
     RETURNING *`,
    [m.min_length, m.require_uppercase, m.require_lowercase, m.require_digits, m.require_special,
     m.max_age_days, m.history_count, m.lockout_attempts, m.lockout_duration_min,
     m.require_2fa, m.require_2fa_roles]);
  return r.rows[0];
}

// Валідація пароля проти політики (для майбутнього використання у зміні пароля).
function validatePassword(pw, policy = DEFAULT_POLICY) {
  const errs = [];
  if (!pw || pw.length < policy.min_length) errs.push(`мінімум ${policy.min_length} символів`);
  if (policy.require_uppercase && !/[A-ZА-ЯЇІЄ]/.test(pw)) errs.push('велика літера');
  if (policy.require_lowercase && !/[a-zа-яїіє]/.test(pw)) errs.push('мала літера');
  if (policy.require_digits && !/\d/.test(pw)) errs.push('цифра');
  if (policy.require_special && !/[^A-Za-zА-Яа-я0-9]/.test(pw)) errs.push('спецсимвол');
  return { valid: errs.length === 0, errors: errs };
}

/* ── Threat Detection (cron) ───────────────────────────────── */

// Скан невдалих логінів. Глобальний read; кластери з >= порогу → security_event
// у контексті тенанта (резолв по користувачу). Дедуп: відкрита подія того ж
// кластера у вікні не дублюється.
async function detectThreats() {
  const clusters = (await query(
    `SELECT identifier, ip, count(*)::int fails, max(created_at) last_at
       FROM auth_attempts
      WHERE success=FALSE AND kind='login'
        AND created_at >= now() - ($1 || ' minutes')::interval
      GROUP BY identifier, ip
     HAVING count(*) >= $2`, [BRUTE_WINDOW_MIN, BRUTE_THRESHOLD])).rows;
  if (!clusters.length) return { clusters: 0, created: 0 };

  const { runAs, DEFAULT_TENANT_ID } = require('./tenant');
  let created = 0;
  for (const c of clusters) {
    // резолв тенанта по користувачу (username/email/phone = identifier)
    let tenantId = DEFAULT_TENANT_ID, userId = null;
    try {
      const u = (await query(
        `SELECT id, tenant_id FROM users
          WHERE username=$1 OR email=$1 OR phone=$1 LIMIT 1`, [c.identifier])).rows[0];
      if (u) { userId = u.id; if (u.tenant_id) tenantId = u.tenant_id; }
    } catch { /* колонок може не бути — лишаємо default */ }

    const clusterKey = `${c.identifier}|${c.ip || ''}`;
    try {
      await runAs(tenantId, async () => {
        const dup = (await getPool().query(
          `SELECT 1 FROM security_events
             WHERE tenant_id=current_tenant_id() AND event_type='brute_force'
               AND resolved=FALSE AND metadata->>'cluster'=$1
               AND created_at >= now() - ($2 || ' minutes')::interval LIMIT 1`,
          [clusterKey, BRUTE_WINDOW_MIN])).rows[0];
        if (dup) return;
        const severity = c.fails >= BRUTE_THRESHOLD * 3 ? 'high' : 'medium';
        await recordEvent({
          user_id: userId, event_type: 'brute_force', severity,
          description: `${c.fails} невдалих спроб входу для «${c.identifier}» за ${BRUTE_WINDOW_MIN} хв`,
          metadata: { cluster: clusterKey, identifier: c.identifier, fails: c.fails, last_at: c.last_at },
          ip_address: c.ip,
        });
        created++;
      });
    } catch (e) { console.error('[security] detectThreats', clusterKey, e.message); }
  }
  return { clusters: clusters.length, created };
}

/* ── Dashboard ─────────────────────────────────────────────── */

async function dashboard() {
  const pool = getPool();
  const activeSessions = (await pool.query(
    `SELECT count(*)::int n FROM user_sessions
       WHERE revoked_at IS NULL AND expires_at > now()`)).rows[0].n;
  const events = await eventStats();
  const whitelist = (await pool.query(
    `SELECT count(*)::int n FROM ip_whitelist WHERE tenant_id=current_tenant_id() AND is_active=TRUE`)).rows[0].n;
  // спроби входу за 7 днів (auth_attempts — глобальна, без tenant; даємо платформну картину)
  let attempts7d = [];
  try {
    attempts7d = (await query(
      `SELECT date_trunc('day', created_at)::date AS day,
              count(*) FILTER (WHERE success)::int AS ok,
              count(*) FILTER (WHERE NOT success)::int AS fail
         FROM auth_attempts
        WHERE kind='login' AND created_at >= now() - interval '7 days'
        GROUP BY day ORDER BY day`)).rows;
  } catch { /* таблиці може не бути */ }
  const recentEvents = (await pool.query(
    `SELECT id, event_type, severity, description, ip_address, resolved, created_at
       FROM security_events WHERE tenant_id=current_tenant_id()
      ORDER BY created_at DESC LIMIT 10`)).rows;
  const policy = await getPolicy();
  return {
    active_sessions: activeSessions,
    open_events: events.open,
    events_by_severity: events.by_severity,
    events_by_type: events.by_type,
    whitelist_count: whitelist,
    login_attempts_7d: attempts7d,
    recent_events: recentEvents,
    password_policy: policy,
  };
}

module.exports = {
  recordEvent, listEvents, resolveEvent, eventStats,
  listWhitelist, addWhitelist, removeWhitelist, isAllowed,
  getPolicy, updatePolicy, validatePassword,
  detectThreats, dashboard,
};
