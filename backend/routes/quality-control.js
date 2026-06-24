/* routes/quality-control.js — AI-10 AI Quality Control
   Монтується як /api/quality-control в shop-api.js.

   Покриває підмодулі AI-10:
     10.01 Review Analysis (NLP-аналіз відгуків)
     10.02 Operational Quality Metrics
     10.03 Quality Scoring (AI Quality Scores — збереження + читання)
     10.04 Alert System (правила + алерти)
     10.05 Predictive Quality (доповнення до /api/quality/at-risk)

   Також: вкладення тайного покупця (MGT-05 / mystery_shopper_attachments).

   Ендпоінти:
     GET  /dashboard                       — дашборд якості (агреговані метрики)
     GET  /scores                          — Quality Scores за сутностями
     GET  /scores/:entity_type/:entity_id  — деталі + history
     POST /scores/upsert                   — зберегти/оновити snapshot (внутрішній)

     GET  /alerts                          — список алертів
     PUT  /alerts/:id/acknowledge          — підтвердити отримання
     PUT  /alerts/:id/resolve              — закрити алерт
     POST /alerts                          — створити алерт вручну

     GET  /rules                           — список правил
     POST /rules                           — створити правило
     PUT  /rules/:id                       — оновити правило
     DELETE /rules/:id                     — видалити правило

     GET  /reviews                         — проаналізовані відгуки
     POST /reviews                         — додати відгук + NLP-аналіз
     GET  /reviews/analytics               — аналітика відгуків

     GET  /predictions                     — предиктивні ризики (churn, burnout, service decline)
     GET  /comparison                      — порівняння філіалів

     GET  /mystery-shopper/:id/attachments        — вкладення звіту тайного покупця
     POST /mystery-shopper/:id/attachments        — додати вкладення
     DELETE /mystery-shopper/:id/attachments/:aid — видалити вкладення
*/

'use strict';

const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
let emit = async () => {};
try { ({ emit } = require('../lib/event-bus')); } catch { /* optional */ }

const router = express.Router();
const pool = getPool();

// ── helpers ──────────────────────────────────────────────────────
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const num = (v) => (v == null || v === '' ? null : Number(v));
const int = (v, def = null) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
const pg_err = (e) => process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;

const SEVERITIES = ['info', 'warning', 'critical', 'emergency'];
const ALERT_STATUSES = ['active', 'acknowledged', 'resolved', 'false_positive', 'auto_resolved'];
const RULE_TYPES = ['threshold', 'trend', 'anomaly', 'score_drop', 'review_negative'];
const ENTITY_TYPES = ['master', 'admin', 'branch', 'service', 'client'];
const SENTIMENT_VALS = ['positive', 'neutral', 'negative'];
const SOURCE_TYPES = ['google_review', 'instagram_comment', 'internal_form', 'telegram', 'chat', 'nps_survey'];

// ── auth: всі GET = ai.quality.read; мутації = ai.quality.write ──
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'ai.quality.read' : 'ai.quality.write';
  return requirePerm(perm)(req, res, next);
});

// ─────────────────────────────────────────────────────────────────
// DASHBOARD  GET /dashboard
// Агреговані метрики + активні алерти + trend за останні N днів
// ?branch_id=&period=7d|30d|90d
// ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const days = ({ '7d': 7, '30d': 30, '90d': 90 })[req.query.period] || 30;
    const since = `NOW() - INTERVAL '${days} days'`;
    const bid = num(req.query.branch_id);

    // Останній branch/salon score
    const scoreWhere = bid
      ? `tenant_id=current_tenant_id() AND entity_type='branch' AND entity_id=$1::text`
      : `tenant_id=current_tenant_id() AND entity_type='branch'`;
    const scoreParams = bid ? [bid] : [];
    const latestScore = (await q(
      `SELECT overall_score, trend, trend_delta, score_date
         FROM ai_quality_scores
        WHERE ${scoreWhere}
        ORDER BY score_date DESC LIMIT 1`,
      scoreParams
    ))[0];

    // Кількість активних алертів
    const alertCount = (await q(
      `SELECT COUNT(*)::int n FROM ai_quality_alerts
        WHERE tenant_id=current_tenant_id() AND status='active'
          ${bid ? 'AND branch_id=$1' : ''}`,
      bid ? [bid] : []
    ))[0].n;

    // Кількість алертів за severity
    const alertsBySeverity = await q(
      `SELECT severity, COUNT(*)::int cnt
         FROM ai_quality_alerts
        WHERE tenant_id=current_tenant_id() AND status='active'
          ${bid ? 'AND branch_id=$1' : ''}
        GROUP BY severity`,
      bid ? [bid] : []
    );

    // Аналітика відгуків за period
    const sentimentAvg = (await q(
      `SELECT ROUND(AVG(sentiment_score)::numeric,3) avg_s,
              COUNT(*) FILTER (WHERE sentiment='positive')::int pos,
              COUNT(*) FILTER (WHERE sentiment='neutral')::int neu,
              COUNT(*) FILTER (WHERE sentiment='negative')::int neg,
              COUNT(*)::int total
         FROM ai_service_analysis
        WHERE tenant_id=current_tenant_id() AND created_at >= ${since}
          ${bid ? 'AND branch_id=$1' : ''}`,
      bid ? [bid] : []
    ))[0];

    // Операційні метрики з appointments
    const apptMetrics = (await q(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow'))::int done,
              COUNT(*) FILTER (WHERE status='noshow')::int noshows,
              COUNT(*) FILTER (WHERE status='cancelled')::int cancels,
              COUNT(*)::int total
         FROM appointments
        WHERE starts_at >= ${since} AND starts_at <= NOW()
          ${bid ? 'AND branch_id=$1' : ''}`,
      bid ? [bid] : []
    ))[0];

    const noShowRate = apptMetrics.total > 0
      ? +(apptMetrics.noshows / apptMetrics.total * 100).toFixed(1) : 0;
    const cancelRate = apptMetrics.total > 0
      ? +(apptMetrics.cancels / apptMetrics.total * 100).toFixed(1) : 0;

    // Тренди scores за period (по тижнях)
    const scoreTrend = await q(
      `SELECT to_char(score_date,'YYYY-WW') wk,
              ROUND(AVG(overall_score)::numeric,2) avg_score,
              entity_type
         FROM ai_quality_scores
        WHERE tenant_id=current_tenant_id()
          AND score_date >= (CURRENT_DATE - INTERVAL '${days} days')
          ${bid ? 'AND branch_id=$1' : ''}
          AND entity_type IN ('branch','master')
        GROUP BY 1,3 ORDER BY 1`,
      bid ? [bid] : []
    );

    res.json({
      period_days: days,
      branch_id: bid,
      quality_score: latestScore ? +latestScore.overall_score : null,
      score_trend: latestScore?.trend || null,
      score_trend_delta: latestScore?.trend_delta ? +latestScore.trend_delta : null,
      score_date: latestScore?.score_date || null,
      active_alerts_count: alertCount,
      alerts_by_severity: alertsBySeverity.reduce((acc, r) => { acc[r.severity] = r.cnt; return acc; }, {}),
      sentiment_avg: sentimentAvg.avg_s ? +sentimentAvg.avg_s : null,
      sentiment_distribution: {
        positive: sentimentAvg.pos,
        neutral: sentimentAvg.neu,
        negative: sentimentAvg.neg,
        total: sentimentAvg.total,
      },
      no_show_rate: noShowRate,
      cancel_rate: cancelRate,
      appointments_done: apptMetrics.done,
      score_trends: scoreTrend,
    });
  } catch (e) {
    console.error('[quality-control:dashboard]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// SCORES  GET /scores
// ?branch_id=&entity_type=master|admin|branch|service
// &sort=score_asc|score_desc&period=7d|30d&page=1&per_page=50
// ─────────────────────────────────────────────────────────────────
router.get('/scores', async (req, res) => {
  try {
    const days = ({ '7d': 7, '30d': 30, '90d': 90 })[req.query.period] || 30;
    const since = `CURRENT_DATE - INTERVAL '${days} days'`;
    const limit = Math.min(200, int(req.query.per_page, 50));
    const offset = (int(req.query.page, 1) - 1) * limit;

    const w = ['s.tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.branch_id) add('s.branch_id=?', num(req.query.branch_id));
    if (req.query.entity_type && ENTITY_TYPES.includes(req.query.entity_type))
      add('s.entity_type=?', req.query.entity_type);

    // беремо останній snapshot за period для кожної (entity_type, entity_id)
    const sort = req.query.sort === 'score_asc' ? 'ASC' : 'DESC';
    p.push(limit); const li = p.length;
    p.push(offset); const oi = p.length;

    const items = await q(
      `SELECT DISTINCT ON (s.entity_type, s.entity_id)
              s.id, s.entity_type, s.entity_id, s.overall_score,
              s.components, s.trend, s.trend_delta, s.score_date,
              s.benchmark_own, s.benchmark_network
         FROM ai_quality_scores s
        WHERE ${w.join(' AND ')} AND s.score_date >= ${since}
        ORDER BY s.entity_type, s.entity_id, s.score_date DESC`,
      p.slice(0, p.length - 2)
    );

    // сортуємо в JS та пагінуємо (щоб не ламати DISTINCT ON)
    const sorted = items.sort((a, b) =>
      sort === 'DESC' ? b.overall_score - a.overall_score : a.overall_score - b.overall_score
    );
    const page = sorted.slice(offset, offset + limit);

    res.json({ items: page, total: items.length, page: int(req.query.page, 1), per_page: limit });
  } catch (e) {
    console.error('[quality-control:scores]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// SCORE DETAIL  GET /scores/:entity_type/:entity_id
// ?from=date&to=date
// ─────────────────────────────────────────────────────────────────
router.get('/scores/:entity_type/:entity_id', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.params;
    if (!ENTITY_TYPES.includes(entity_type))
      return res.status(400).json({ error: 'invalid entity_type' });

    const from = req.query.from || null;
    const to   = req.query.to   || null;

    const w = ['tenant_id=current_tenant_id()', 'entity_type=$1', 'entity_id=$2'];
    const p = [entity_type, entity_id];
    if (from) { p.push(from); w.push(`score_date>=$${p.length}`); }
    if (to)   { p.push(to);   w.push(`score_date<=$${p.length}`); }

    const history = await q(
      `SELECT score_date, overall_score, components, trend, trend_delta,
              benchmark_own, benchmark_network
         FROM ai_quality_scores WHERE ${w.join(' AND ')}
        ORDER BY score_date DESC LIMIT 90`,
      p
    );

    if (!history.length) return res.status(404).json({ error: 'no scores found' });

    const current = history[0];

    // Слабкі місця: компоненти з мінімальним балом
    const comps = current.components || {};
    const weakPoints = Object.entries(comps)
      .sort(([, a], [, b]) => a - b)
      .slice(0, 3)
      .map(([k, v]) => ({ metric: k, value: v }));

    res.json({
      entity_type,
      entity_id,
      current_score: +current.overall_score,
      components: comps,
      trend: current.trend,
      trend_delta: current.trend_delta ? +current.trend_delta : null,
      benchmark_own: current.benchmark_own ? +current.benchmark_own : null,
      benchmark_network: current.benchmark_network ? +current.benchmark_network : null,
      weak_points: weakPoints,
      history: history.map(h => ({
        date: h.score_date,
        score: +h.overall_score,
        trend: h.trend,
      })),
    });
  } catch (e) {
    console.error('[quality-control:score-detail]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// SCORE UPSERT  POST /scores/upsert
// Внутрішній: зберегти щоденний snapshot (викликається cron/event)
// Body: { entity_type, entity_id, branch_id?, overall_score, components, trend?, trend_delta?, benchmark_own?, benchmark_network?, score_date? }
// ─────────────────────────────────────────────────────────────────
router.post('/scores/upsert', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.entity_type || !b.entity_id || b.overall_score == null)
      return res.status(400).json({ error: 'entity_type, entity_id, overall_score required' });
    if (!ENTITY_TYPES.includes(b.entity_type))
      return res.status(400).json({ error: 'invalid entity_type' });

    const scoreDate = b.score_date || new Date().toISOString().slice(0, 10);
    const row = (await q(
      `INSERT INTO ai_quality_scores
         (branch_id, entity_type, entity_id, score_date, overall_score, components,
          trend, trend_delta, benchmark_own, benchmark_network)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, entity_type, entity_id, score_date) DO UPDATE
         SET overall_score=$5, components=$6, trend=COALESCE($7, ai_quality_scores.trend),
             trend_delta=$8, benchmark_own=$9, benchmark_network=$10
       RETURNING *`,
      [num(b.branch_id), b.entity_type, String(b.entity_id), scoreDate,
       +b.overall_score, JSON.stringify(b.components || {}),
       b.trend || 'stable', b.trend_delta != null ? +b.trend_delta : null,
       b.benchmark_own != null ? +b.benchmark_own : null,
       b.benchmark_network != null ? +b.benchmark_network : null]
    ))[0];

    await emit('ai.quality_score.upserted',
      { entity_type: b.entity_type, entity_id: b.entity_id, score: row.overall_score },
      { entityType: 'ai_quality_score', entityId: String(row.id), actor: String(req.user?.id || 'system') }
    );
    res.status(201).json(row);
  } catch (e) {
    console.error('[quality-control:score-upsert]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// ALERTS  GET /alerts
// ?branch_id=&status=active|acknowledged|resolved&severity=warning|critical|emergency
// &entity_type=master|admin|branch&page=1&per_page=50
// ─────────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const limit = Math.min(200, int(req.query.per_page, 50));
    const offset = (int(req.query.page, 1) - 1) * limit;

    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };

    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (req.query.status && ALERT_STATUSES.includes(req.query.status))
      add('status=?', req.query.status);
    if (req.query.severity && SEVERITIES.includes(req.query.severity))
      add('severity=?', req.query.severity);
    if (req.query.entity_type && ENTITY_TYPES.includes(req.query.entity_type))
      add('entity_type=?', req.query.entity_type);

    const countRow = (await q(`SELECT COUNT(*)::int n FROM ai_quality_alerts WHERE ${w.join(' AND ')}`, p))[0];
    const activeCount = (await q(`SELECT COUNT(*)::int n FROM ai_quality_alerts WHERE tenant_id=current_tenant_id() AND status='active'`, []))[0].n;

    p.push(limit); const li = p.length;
    p.push(offset); const oi = p.length;

    const items = await q(
      `SELECT id, branch_id, rule_id, entity_type, entity_id, severity, title,
              description, metric_name, metric_value, threshold_value,
              recommended_actions, status, acknowledged_by, acknowledged_at,
              action_plan, resolved_at, created_at
         FROM ai_quality_alerts
        WHERE ${w.join(' AND ')}
        ORDER BY array_position(ARRAY['emergency','critical','warning','info'], severity),
                 created_at DESC
        LIMIT $${li} OFFSET $${oi}`,
      p
    );

    res.json({ items, total: countRow.n, active_count: activeCount });
  } catch (e) {
    console.error('[quality-control:alerts]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// CREATE ALERT  POST /alerts  (ручне створення або з Engine)
// ─────────────────────────────────────────────────────────────────
router.post('/alerts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.entity_type || !b.entity_id || !b.title || !b.metric_name)
      return res.status(400).json({ error: 'entity_type, entity_id, title, metric_name required' });
    const sev = SEVERITIES.includes(b.severity) ? b.severity : 'warning';
    const row = (await q(
      `INSERT INTO ai_quality_alerts
         (branch_id, rule_id, entity_type, entity_id, severity, title, description,
          metric_name, metric_value, threshold_value, recommended_actions, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active') RETURNING *`,
      [num(b.branch_id), num(b.rule_id), b.entity_type, String(b.entity_id),
       sev, b.title, b.description || '',
       b.metric_name, b.metric_value != null ? +b.metric_value : null,
       b.threshold_value != null ? +b.threshold_value : null,
       JSON.stringify(Array.isArray(b.recommended_actions) ? b.recommended_actions : [])]
    ))[0];

    if (b.rule_id) {
      await q(`UPDATE ai_quality_rules
               SET triggers_count=triggers_count+1, last_triggered_at=NOW()
               WHERE id=$1 AND tenant_id=current_tenant_id()`, [num(b.rule_id)]);
    }

    await emit('ai.quality_alert.created',
      { id: row.id, severity: sev, entity_type: b.entity_type, entity_id: b.entity_id },
      { entityType: 'ai_quality_alert', entityId: String(row.id), actor: String(req.user?.id || 'system') }
    );
    await logAction({ user: req.user, action: 'ai.quality.alert.create', entity: 'ai_quality_alert', entity_id: row.id, ip: req.ip, meta: { severity: sev } });
    res.status(201).json(row);
  } catch (e) {
    console.error('[quality-control:alert-create]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// ACKNOWLEDGE ALERT  PUT /alerts/:id/acknowledge
// Body: { action_plan? }
// ─────────────────────────────────────────────────────────────────
router.put('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const row = (await q(
      `UPDATE ai_quality_alerts
          SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW(),
              action_plan=COALESCE($2, action_plan)
        WHERE id=$3 AND tenant_id=current_tenant_id() AND status='active'
        RETURNING id, status, acknowledged_at, action_plan`,
      [req.user?.id ?? null, req.body?.action_plan || null, req.params.id]
    ))[0];
    if (!row) return res.status(404).json({ error: 'alert not found or not active' });
    await logAction({ user: req.user, action: 'ai.quality.alert.acknowledge', entity: 'ai_quality_alert', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) {
    console.error('[quality-control:alert-acknowledge]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// RESOLVE ALERT  PUT /alerts/:id/resolve
// Body: { resolution_note?, is_false_positive? }
// ─────────────────────────────────────────────────────────────────
router.put('/alerts/:id/resolve', async (req, res) => {
  try {
    const isFp = req.body?.is_false_positive === true;
    const newStatus = isFp ? 'false_positive' : 'resolved';
    const row = (await q(
      `UPDATE ai_quality_alerts
          SET status=$1, resolved_at=NOW(),
              action_plan=COALESCE($2, action_plan)
        WHERE id=$3 AND tenant_id=current_tenant_id()
          AND status IN ('active','acknowledged')
        RETURNING id, status, resolved_at`,
      [newStatus, req.body?.resolution_note || null, req.params.id]
    ))[0];
    if (!row) return res.status(404).json({ error: 'alert not found or already closed' });
    await logAction({ user: req.user, action: 'ai.quality.alert.resolve', entity: 'ai_quality_alert', entity_id: row.id, ip: req.ip, meta: { status: newStatus } });
    res.json(row);
  } catch (e) {
    console.error('[quality-control:alert-resolve]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// RULES  GET /rules
// ?branch_id=&is_enabled=true|false
// ─────────────────────────────────────────────────────────────────
router.get('/rules', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (req.query.is_enabled != null)
      add('is_enabled=?', req.query.is_enabled === 'true' || req.query.is_enabled === '1');

    const rules = await q(
      `SELECT id, branch_id, name, rule_type, metric, entity_type, condition_json,
              severity, cooldown_hours, escalation_chain, is_enabled,
              triggers_count, last_triggered_at, created_by, created_at, updated_at
         FROM ai_quality_rules WHERE ${w.join(' AND ')}
        ORDER BY is_enabled DESC, id DESC`,
      p
    );
    res.json({ rules, total: rules.length });
  } catch (e) {
    console.error('[quality-control:rules]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// CREATE RULE  POST /rules
// Body: { name, rule_type, metric, entity_type?, branch_id?, condition, severity, cooldown_hours?, escalation_chain? }
// ─────────────────────────────────────────────────────────────────
router.post('/rules', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.metric || !b.condition)
      return res.status(400).json({ error: 'name, metric, condition required' });
    const rtype = RULE_TYPES.includes(b.rule_type) ? b.rule_type : 'threshold';
    const sev   = SEVERITIES.includes(b.severity)  ? b.severity  : 'warning';

    const row = (await q(
      `INSERT INTO ai_quality_rules
         (branch_id, name, rule_type, metric, entity_type, condition_json,
          severity, cooldown_hours, escalation_chain, is_enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true),$11)
       RETURNING *`,
      [num(b.branch_id), b.name, rtype, b.metric,
       b.entity_type || null,
       JSON.stringify(b.condition), sev,
       int(b.cooldown_hours, 24),
       JSON.stringify(Array.isArray(b.escalation_chain) ? b.escalation_chain : []),
       b.is_enabled, req.user?.id ?? null]
    ))[0];

    await logAction({ user: req.user, action: 'ai.quality.rule.create', entity: 'ai_quality_rule', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) {
    console.error('[quality-control:rule-create]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// UPDATE RULE  PUT /rules/:id
// Body: { name?, condition?, severity?, cooldown_hours?, escalation_chain?, is_enabled? }
// ─────────────────────────────────────────────────────────────────
router.put('/rules/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const f = []; const p = [];
    const set = (c, v) => { p.push(v); f.push(`${c}=$${p.length}`); };
    const setJ = (c, v) => { p.push(JSON.stringify(v)); f.push(`${c}=$${p.length}::jsonb`); };

    if (b.name != null) set('name', b.name);
    if (b.metric != null) set('metric', b.metric);
    if (b.entity_type !== undefined) set('entity_type', b.entity_type);
    if (b.rule_type != null && RULE_TYPES.includes(b.rule_type)) set('rule_type', b.rule_type);
    if (b.condition != null) setJ('condition_json', b.condition);
    if (b.severity != null && SEVERITIES.includes(b.severity)) set('severity', b.severity);
    if (b.cooldown_hours != null) set('cooldown_hours', int(b.cooldown_hours, 24));
    if (b.escalation_chain != null) setJ('escalation_chain', b.escalation_chain);
    if (b.is_enabled != null) set('is_enabled', !!b.is_enabled);

    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(
      `UPDATE ai_quality_rules
          SET ${f.join(',')}, updated_at=NOW()
        WHERE id=$${p.length} AND tenant_id=current_tenant_id()
        RETURNING *`,
      p
    ))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    console.error('[quality-control:rule-update]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE RULE  DELETE /rules/:id
// ─────────────────────────────────────────────────────────────────
router.delete('/rules/:id', async (req, res) => {
  try {
    const row = (await q(
      `DELETE FROM ai_quality_rules WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`,
      [req.params.id]
    ))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'ai.quality.rule.delete', entity: 'ai_quality_rule', entity_id: row.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error('[quality-control:rule-delete]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// REVIEWS  GET /reviews
// ?branch_id=&source_type=&sentiment=positive|negative&urgency=high|critical
// &is_actionable=true&from=date&to=date&page=1&per_page=50
// ─────────────────────────────────────────────────────────────────
router.get('/reviews', async (req, res) => {
  try {
    const limit = Math.min(200, int(req.query.per_page, 50));
    const offset = (int(req.query.page, 1) - 1) * limit;

    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };

    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (req.query.source_type && SOURCE_TYPES.includes(req.query.source_type))
      add('source_type=?', req.query.source_type);
    if (req.query.sentiment && SENTIMENT_VALS.includes(req.query.sentiment))
      add('sentiment=?', req.query.sentiment);
    if (req.query.urgency) add('urgency=?', req.query.urgency);
    if (req.query.is_actionable === 'true') w.push('is_actionable=TRUE');
    if (req.query.from) add('created_at>=?', req.query.from);
    if (req.query.to)   add('created_at<=?', req.query.to);

    const countRow = (await q(`SELECT COUNT(*)::int n FROM ai_service_analysis WHERE ${w.join(' AND ')}`, p))[0];
    p.push(limit); const li = p.length;
    p.push(offset); const oi = p.length;

    const items = await q(
      `SELECT id, branch_id, source_type, source_id, source_url, client_id,
              raw_text, language, sentiment, sentiment_score,
              aspects, entities, emotions, urgency, is_actionable,
              suggested_response, processed_at, created_at
         FROM ai_service_analysis
        WHERE ${w.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${li} OFFSET $${oi}`,
      p
    );

    res.json({ items, total: countRow.n });
  } catch (e) {
    console.error('[quality-control:reviews]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// ADD REVIEW  POST /reviews
// Body: { raw_text, source_type?, sentiment, sentiment_score, aspects?, entities?,
//         emotions?, urgency?, is_actionable?, suggested_response?, client_id?,
//         branch_id?, source_id?, source_url?, language? }
// ─────────────────────────────────────────────────────────────────
router.post('/reviews', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.raw_text || !b.sentiment)
      return res.status(400).json({ error: 'raw_text and sentiment required' });
    if (!SENTIMENT_VALS.includes(b.sentiment))
      return res.status(400).json({ error: 'sentiment must be positive|neutral|negative' });

    const row = (await q(
      `INSERT INTO ai_service_analysis
         (branch_id, source_type, source_id, source_url, client_id, raw_text, language,
          sentiment, sentiment_score, aspects, entities, emotions,
          urgency, is_actionable, suggested_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [num(b.branch_id),
       SOURCE_TYPES.includes(b.source_type) ? b.source_type : 'internal_form',
       b.source_id || null, b.source_url || null, num(b.client_id),
       b.raw_text, b.language || 'uk',
       b.sentiment, b.sentiment_score != null ? +b.sentiment_score : 0,
       JSON.stringify(Array.isArray(b.aspects) ? b.aspects : []),
       JSON.stringify(b.entities && typeof b.entities === 'object' ? b.entities : {}),
       JSON.stringify(Array.isArray(b.emotions) ? b.emotions : []),
       b.urgency || 'normal',
       !!b.is_actionable,
       b.suggested_response || null]
    ))[0];

    await emit('ai.review.analyzed',
      { id: row.id, sentiment: b.sentiment, urgency: b.urgency || 'normal', is_actionable: !!b.is_actionable },
      { entityType: 'ai_service_analysis', entityId: String(row.id), actor: String(req.user?.id || 'system') }
    );
    res.status(201).json(row);
  } catch (e) {
    console.error('[quality-control:review-add]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// REVIEWS ANALYTICS  GET /reviews/analytics
// ?branch_id=&from=date&to=date
// ─────────────────────────────────────────────────────────────────
router.get('/reviews/analytics', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (req.query.from) add('created_at>=?', req.query.from);
    if (req.query.to)   add('created_at<=?', req.query.to);

    const where = w.join(' AND ');

    const [overview, bySource, byWeek] = await Promise.all([
      q(`SELECT COUNT(*)::int total,
                COUNT(*) FILTER (WHERE sentiment='positive')::int positive,
                COUNT(*) FILTER (WHERE sentiment='neutral')::int neutral,
                COUNT(*) FILTER (WHERE sentiment='negative')::int negative,
                ROUND(AVG(sentiment_score)::numeric,3) avg_score,
                COUNT(*) FILTER (WHERE is_actionable=TRUE)::int actionable,
                COUNT(*) FILTER (WHERE urgency='critical')::int critical_count
           FROM ai_service_analysis WHERE ${where}`, p),
      q(`SELECT source_type, COUNT(*)::int cnt,
                ROUND(AVG(sentiment_score)::numeric,3) avg_score
           FROM ai_service_analysis WHERE ${where}
          GROUP BY source_type ORDER BY cnt DESC`, p),
      q(`SELECT to_char(date_trunc('week', created_at),'YYYY-WW') wk,
                COUNT(*)::int cnt,
                ROUND(AVG(sentiment_score)::numeric,3) avg_score,
                COUNT(*) FILTER (WHERE sentiment='negative')::int neg
           FROM ai_service_analysis WHERE ${where}
          GROUP BY 1 ORDER BY 1 LIMIT 52`, p),
    ]);

    res.json({
      total_reviews: overview[0].total,
      sentiment_distribution: {
        positive: overview[0].positive,
        neutral: overview[0].neutral,
        negative: overview[0].negative,
      },
      avg_sentiment_score: overview[0].avg_score ? +overview[0].avg_score : null,
      actionable_count: overview[0].actionable,
      critical_count: overview[0].critical_count,
      by_source: bySource,
      trend_weekly: byWeek,
    });
  } catch (e) {
    console.error('[quality-control:reviews-analytics]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// PREDICTIONS  GET /predictions
// ?branch_id=&type=churn|burnout|service_decline&min_risk=0.5
// Доповнює /api/quality/at-risk — тут структурований формат AI-10
// ─────────────────────────────────────────────────────────────────
router.get('/predictions', async (req, res) => {
  try {
    const minRisk = Math.max(0, Math.min(1, parseFloat(req.query.min_risk) || 0.5));
    const type = req.query.type || null;
    const bid  = num(req.query.branch_id);
    const branchFilter = bid ? 'AND a.branch_id=$1' : '';
    const branchParams = bid ? [bid] : [];

    const predictions = [];

    // ── CHURN RISK: клієнти з overdue_ratio >= min_risk*2 ─────────
    if (!type || type === 'churn') {
      const churnRows = await q(
        `WITH cv AS (
           SELECT c.id, c.name, c.phone, c.total_spent,
                  COUNT(a.id)::int visits,
                  MAX(a.starts_at) last_v,
                  MIN(a.starts_at) first_v
             FROM clients c
             JOIN appointments a ON a.client_id=c.id
            WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW()
              ${bid ? branchFilter.replace('a.branch_id=$1', 'a.branch_id=$1') : ''}
            GROUP BY c.id, c.name, c.phone, c.total_spent
           HAVING COUNT(a.id) >= 3
         )
         SELECT *,
                (EXTRACT(EPOCH FROM (last_v - first_v))/86400.0 / NULLIF(visits-1,0)) avg_interval,
                (CURRENT_DATE - last_v::date)::int days_since
           FROM cv`,
        branchParams
      );

      for (const r of churnRows) {
        const avg = Number(r.avg_interval) || 0;
        if (avg <= 0) continue;
        const ratio = r.days_since / avg;
        if (ratio < 1.2 || ratio > 5) continue;
        const riskScore = Math.min(1, (ratio - 1) / 3);
        if (riskScore < minRisk) continue;

        predictions.push({
          entity_type: 'client',
          entity_id: String(r.id),
          entity_name: r.name,
          phone: r.phone,
          risk_type: 'churn',
          risk_score: +riskScore.toFixed(2),
          signals: [
            `Остан. візит ${r.days_since} дн. тому (звичайний інтервал ${Math.round(avg)} дн.)`,
            `Перевищення інтервалу: x${ratio.toFixed(1)}`,
            `Всього візитів: ${r.visits}`,
          ],
          recommended_actions: [
            'Зателефонувати клієнту',
            'Надіслати персональну пропозицію',
            'Перевірити останні відгуки',
          ],
          total_spent: Math.round(Number(r.total_spent || 0)),
        });
      }
    }

    // ── BURNOUT RISK: майстри з падінням score + ростом NC ────────
    if (!type || type === 'burnout') {
      const burnoutRows = await q(
        `SELECT m.id, m.name,
                COUNT(nc.id) FILTER (WHERE nc.created_at >= NOW() - INTERVAL '30 days')::int nc_30d,
                COUNT(nc.id) FILTER (WHERE nc.created_at >= NOW() - INTERVAL '60 days'
                                      AND nc.created_at <  NOW() - INTERVAL '30 days')::int nc_prev,
                ROUND(AVG(ch.total_score)::numeric,2) avg_score_recent
           FROM masters m
           LEFT JOIN qc_non_conformities nc ON nc.employee_id=m.id AND nc.tenant_id=current_tenant_id()
           LEFT JOIN qc_checks ch ON ch.inspected_employee_id=m.id
                AND ch.tenant_id=current_tenant_id() AND ch.completed_at >= NOW()-INTERVAL '60 days'
          WHERE m.active=TRUE
          GROUP BY m.id, m.name
         HAVING COUNT(nc.id) FILTER (WHERE nc.created_at >= NOW()-INTERVAL '30 days') >= 2`,
        []
      );

      for (const r of burnoutRows) {
        const ncGrowth = r.nc_prev > 0 ? r.nc_30d / r.nc_prev : 2;
        const riskScore = Math.min(1, ncGrowth / 3 + (r.avg_score_recent != null ? (100 - r.avg_score_recent) / 100 * 0.3 : 0.2));
        if (riskScore < minRisk) continue;

        predictions.push({
          entity_type: 'master',
          entity_id: String(r.id),
          entity_name: r.name,
          risk_type: 'burnout',
          risk_score: +riskScore.toFixed(2),
          signals: [
            `Несоответствій за 30 дн: ${r.nc_30d} (попередній місяць: ${r.nc_prev})`,
            r.avg_score_recent ? `Середній бал перевірок: ${r.avg_score_recent}` : 'Немає даних по балах',
          ],
          recommended_actions: [
            'Провести індивідуальну бесіду',
            'Переглянути навантаження майстра',
            'Призначити позапланову перевірку',
          ],
        });
      }
    }

    // ── SERVICE DECLINE: послуги з негативним sentiment ───────────
    if (!type || type === 'service_decline') {
      const svcDecline = await q(
        `SELECT sa.entities->>'services' svc_raw,
                COUNT(*) FILTER (WHERE sa.sentiment='negative')::int neg_cnt,
                COUNT(*)::int total_cnt,
                ROUND(AVG(sa.sentiment_score)::numeric,3) avg_sent
           FROM ai_service_analysis sa
          WHERE sa.tenant_id=current_tenant_id()
            AND sa.created_at >= NOW() - INTERVAL '30 days'
            AND sa.entities->>'services' IS NOT NULL
            AND sa.entities->>'services' != 'null'
            ${bid ? 'AND sa.branch_id=$1' : ''}
          GROUP BY sa.entities->>'services'
         HAVING COUNT(*) FILTER (WHERE sa.sentiment='negative') >= 2
            AND (COUNT(*) FILTER (WHERE sa.sentiment='negative')::float / COUNT(*)) >= 0.3`,
        bid ? [bid] : []
      );

      for (const r of svcDecline) {
        const negRate = r.total_cnt > 0 ? r.neg_cnt / r.total_cnt : 0;
        const riskScore = Math.min(1, negRate);
        if (riskScore < minRisk) continue;

        predictions.push({
          entity_type: 'service',
          entity_id: r.svc_raw || 'unknown',
          entity_name: r.svc_raw || 'Невідома послуга',
          risk_type: 'service_decline',
          risk_score: +riskScore.toFixed(2),
          signals: [
            `${r.neg_cnt} негативних відгуків з ${r.total_cnt} за 30 дн.`,
            `Середній sentiment: ${r.avg_sent}`,
          ],
          recommended_actions: [
            'Перевірити технологію / матеріали',
            'Провести навчання майстрів',
            'Порівняти результати before/after',
          ],
        });
      }
    }

    predictions.sort((a, b) => b.risk_score - a.risk_score);
    res.json({ predictions, total: predictions.length });
  } catch (e) {
    console.error('[quality-control:predictions]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// COMPARISON  GET /comparison
// ?branch_ids=UUID,UUID,...&period=30d
// Порівняння філіалів за останніми scores + метриками відгуків
// ─────────────────────────────────────────────────────────────────
router.get('/comparison', async (req, res) => {
  try {
    const branchIdsRaw = (req.query.branch_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const days = ({ '7d': 7, '30d': 30, '90d': 90 })[req.query.period] || 30;
    const since = `CURRENT_DATE - INTERVAL '${days} days'`;

    // Якщо branch_ids не вказані — беремо всі філіали тенанта
    let branchFilter = ''; const bp = [];
    if (branchIdsRaw.length) {
      const ph = branchIdsRaw.map((_, i) => `$${i + 1}`).join(',');
      branchFilter = `AND branch_id IN (${ph})`;
      bp.push(...branchIdsRaw.map(Number));
    }

    const scores = await q(
      `SELECT DISTINCT ON (branch_id)
              branch_id, overall_score, trend, score_date
         FROM ai_quality_scores
        WHERE tenant_id=current_tenant_id()
          AND entity_type='branch' AND score_date >= ${since}
          ${branchFilter}
        ORDER BY branch_id, score_date DESC`,
      bp
    );

    const sentiments = await q(
      `SELECT branch_id,
              COUNT(*)::int total_reviews,
              ROUND(AVG(sentiment_score)::numeric,3) avg_sentiment,
              COUNT(*) FILTER (WHERE sentiment='negative')::int neg_count
         FROM ai_service_analysis
        WHERE tenant_id=current_tenant_id()
          AND created_at >= NOW() - INTERVAL '${days} days'
          ${branchFilter}
        GROUP BY branch_id`,
      bp
    );

    const sentMap = {};
    for (const s of sentiments) sentMap[s.branch_id] = s;

    const branches = scores.map(s => ({
      branch_id: s.branch_id,
      quality_score: +s.overall_score,
      trend: s.trend,
      score_date: s.score_date,
      avg_sentiment: sentMap[s.branch_id]?.avg_sentiment ? +sentMap[s.branch_id].avg_sentiment : null,
      total_reviews: sentMap[s.branch_id]?.total_reviews || 0,
      neg_reviews: sentMap[s.branch_id]?.neg_count || 0,
    }));

    const best = branches.length ? branches.reduce((a, b) => a.quality_score > b.quality_score ? a : b) : null;
    const worst = branches.length ? branches.reduce((a, b) => a.quality_score < b.quality_score ? a : b) : null;

    res.json({ branches, best_branch_id: best?.branch_id || null, worst_branch_id: worst?.branch_id || null, period_days: days });
  } catch (e) {
    console.error('[quality-control:comparison]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

// ─────────────────────────────────────────────────────────────────
// MYSTERY SHOPPER ATTACHMENTS  (MGT-05 доповнення)
// GET  /mystery-shopper/:id/attachments
// POST /mystery-shopper/:id/attachments
// DELETE /mystery-shopper/:id/attachments/:aid
// ─────────────────────────────────────────────────────────────────
router.get('/mystery-shopper/:id/attachments', async (req, res) => {
  try {
    const report = (await q(
      `SELECT id FROM mystery_shopper_reports WHERE id=$1 AND tenant_id=current_tenant_id()`,
      [req.params.id]
    ))[0];
    if (!report) return res.status(404).json({ error: 'report not found' });

    const items = await q(
      `SELECT id, file_url, file_name, file_size, mime_type, media_type, created_at
         FROM mystery_shopper_attachments
        WHERE report_id=$1 AND tenant_id=current_tenant_id()
        ORDER BY created_at ASC`,
      [report.id]
    );
    res.json({ items, total: items.length });
  } catch (e) {
    console.error('[quality-control:ms-attachments-list]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

router.post('/mystery-shopper/:id/attachments', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.file_url) return res.status(400).json({ error: 'file_url required' });

    const report = (await q(
      `SELECT id FROM mystery_shopper_reports WHERE id=$1 AND tenant_id=current_tenant_id()`,
      [req.params.id]
    ))[0];
    if (!report) return res.status(404).json({ error: 'report not found' });

    const mediaType = ['photo', 'audio', 'video'].includes(b.media_type) ? b.media_type : 'photo';
    const row = (await q(
      `INSERT INTO mystery_shopper_attachments
         (report_id, file_url, file_name, file_size, mime_type, media_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [report.id, b.file_url, b.file_name || null, int(b.file_size), b.mime_type || null, mediaType]
    ))[0];
    res.status(201).json(row);
  } catch (e) {
    console.error('[quality-control:ms-attachments-add]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

router.delete('/mystery-shopper/:id/attachments/:aid', async (req, res) => {
  try {
    // перевіряємо що report належить тенанту
    const report = (await q(
      `SELECT id FROM mystery_shopper_reports WHERE id=$1 AND tenant_id=current_tenant_id()`,
      [req.params.id]
    ))[0];
    if (!report) return res.status(404).json({ error: 'report not found' });

    const row = (await q(
      `DELETE FROM mystery_shopper_attachments
        WHERE id=$1 AND report_id=$2 AND tenant_id=current_tenant_id()
        RETURNING id`,
      [req.params.aid, report.id]
    ))[0];
    if (!row) return res.status(404).json({ error: 'attachment not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[quality-control:ms-attachments-delete]', e);
    res.status(500).json({ error: pg_err(e) });
  }
});

module.exports = router;
