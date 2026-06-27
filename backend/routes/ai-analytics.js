/* routes/ai-analytics.js — AI-04 Predictive Analytics (прагматична версія для 1 салону).

   Без важких ML-бібліотек: евристики поверх реальних даних
   (clients / appointments / cash_operations). Результати персистяться у
   ai_predictions / ai_anomalies / ai_insights / ai_nl_queries (міграція 187).

   Ендпоінти (mount: /api/ai/analytics):
     GET  /summary                — зведення: ризик відтоку, аномалії, інсайти
     GET  /predictions            — список збережених прогнозів
     GET  /predictions/churn      — ризик відтоку по клієнтах (наживо + персист)
     GET  /predictions/revenue    — прогноз виручки наступного періоду
     GET  /predictions/ltv        — LTV-сегментація клієнтів
     GET  /anomalies              — виявлені аномалії (z-score по метриках)
     POST /anomalies/scan         — перерахувати аномалії за період
     PUT  /anomalies/:id          — змінити статус (acknowledge/resolve/ignore)
     GET  /insights               — авто-інсайти (із рекомендаціями)
     POST /insights/scan          — згенерувати інсайти наживо
     POST /insights/:id/apply     — позначити інсайт застосованим / відхиленим
     GET  /recommendations        — топ-рекомендації до дій
     POST /ask                    — NLP-запит до даних (через lib/llm)

   Доступ: reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();
const DAY_MS = 24 * 3600 * 1000;

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

// ── Денний ряд метрики за N днів (з заповненням нулями) ───────
async function dailySeries(metric, days = 90) {
  let sql;
  if (metric === 'revenue') {
    sql = `SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d, SUM(amount)::numeric AS v
             FROM cash_operations
            WHERE type='in' AND category IN ('sale_service','sale_product')
              AND created_at >= NOW() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 1`;
  } else if (metric === 'appointments') {
    sql = `SELECT to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d, COUNT(*)::numeric AS v
             FROM appointments
            WHERE starts_at >= NOW() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 1`;
  } else if (metric === 'noshow') {
    sql = `SELECT to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d,
                  COUNT(*) FILTER (WHERE status IN ('noshow','cancelled'))::numeric AS v
             FROM appointments
            WHERE starts_at >= NOW() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 1`;
  } else if (metric === 'avg_check') {
    sql = `SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d,
                  AVG(amount)::numeric AS v
             FROM cash_operations
            WHERE type='in' AND category IN ('sale_service','sale_product')
              AND created_at >= NOW() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 1`;
  } else {
    throw new Error('unknown metric');
  }
  const rows = (await pool.query(sql, [String(days)])).rows;
  const map = new Map(rows.map(r => [r.d, num(r.v)]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * DAY_MS);
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
    out.push({ d: key, v: map.get(key) || 0 });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  CHURN — ризик відтоку клієнтів
//  Евристика: інтервал між візитами (каденція) vs час із останнього візиту.
//  risk = clamp((daysSince - cadence) / (2*cadence), 0..1), зважений на цінність.
// ═══════════════════════════════════════════════════════════
async function computeChurn(limit = 100) {
  const rows = (await pool.query(
    `WITH visits AS (
        SELECT client_id,
               COUNT(*) FILTER (WHERE status IN ('done','confirmed','booked')) AS visit_count,
               MIN(starts_at) AS first_visit,
               MAX(starts_at) AS last_visit
          FROM appointments
         WHERE client_id IS NOT NULL
         GROUP BY client_id
      )
      SELECT c.id, c.name, c.phone, c.total_spent, c.loyalty_points,
             v.visit_count, v.first_visit, v.last_visit
        FROM clients c JOIN visits v ON v.client_id = c.id
       WHERE v.visit_count >= 2
       ORDER BY c.total_spent DESC NULLS LAST
       LIMIT $1`, [limit])).rows;

  const now = Date.now();
  const out = [];
  for (const r of rows) {
    const first = new Date(r.first_visit).getTime();
    const last = new Date(r.last_visit).getTime();
    const vc = num(r.visit_count);
    if (vc < 2 || !first || !last) continue;
    // середній інтервал між візитами
    const spanDays = Math.max(1, (last - first) / DAY_MS);
    const cadence = spanDays / (vc - 1);          // днів між візитами
    const daysSince = (now - last) / DAY_MS;
    let risk = (daysSince - cadence) / (2 * cadence);
    risk = Math.max(0, Math.min(1, risk));
    // VIP-клієнти важливіші — підсвічуємо ризик через value-вагу
    const value = num(r.total_spent);
    const band = risk >= 0.66 ? 'high' : risk >= 0.33 ? 'medium' : 'low';
    out.push({
      client_id: r.id, name: r.name, phone: r.phone,
      visit_count: vc,
      cadence_days: Math.round(cadence),
      days_since_visit: Math.round(daysSince),
      total_spent: value,
      risk: Math.round(risk * 100) / 100,
      band,
      priority: Math.round(risk * Math.log10(value + 10) * 100) / 100,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

// ═══════════════════════════════════════════════════════════
//  ANOMALIES — z-score по денних рядах
// ═══════════════════════════════════════════════════════════
async function scanAnomalies(days = 60, z = 2.2) {
  const metrics = ['revenue', 'appointments', 'noshow', 'avg_check'];
  const found = [];
  for (const metric of metrics) {
    const series = await dailySeries(metric, days);
    const vals = series.map(s => s.v);
    if (vals.length < 14) continue;
    // базова статистика без останніх 3 днів (щоб не «розмивати» свіжий сплеск)
    const base = vals.slice(0, -3);
    const m = mean(base), sd = stdev(base);
    if (sd < 1e-6) continue;
    // перевіряємо останні 7 днів
    for (const pt of series.slice(-7)) {
      const zsc = (pt.v - m) / sd;
      if (Math.abs(zsc) >= z) {
        const direction = zsc > 0 ? 'spike' : 'drop';
        const severity = Math.abs(zsc) >= 3.5 ? 'high' : Math.abs(zsc) >= 2.8 ? 'medium' : 'low';
        found.push({ metric, anomaly_date: pt.d, observed: pt.v, expected: Math.round(m * 100) / 100, z_score: Math.round(zsc * 100) / 100, direction, severity });
      }
    }
  }
  // персист (UPSERT по metric+date)
  for (const a of found) {
    await pool.query(
      `INSERT INTO ai_anomalies (metric, anomaly_date, observed, expected, z_score, direction, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (metric, anomaly_date) DO UPDATE SET
         observed=EXCLUDED.observed, expected=EXCLUDED.expected,
         z_score=EXCLUDED.z_score, direction=EXCLUDED.direction, severity=EXCLUDED.severity`,
      [a.metric, a.anomaly_date, a.observed, a.expected, a.z_score, a.direction, a.severity]);
  }
  return found;
}

// ═══════════════════════════════════════════════════════════
//  INSIGHTS — авто-інсайти з рекомендаціями
// ═══════════════════════════════════════════════════════════
async function scanInsights() {
  const insights = [];
  const push = (category, severity, title, body, action, metric_value, fp) =>
    insights.push({ category, severity, title, body, action, metric_value, fingerprint: fp });

  // 1) Динаміка виручки (останні 30 vs попередні 30)
  const rev = await dailySeries('revenue', 60);
  const prev30 = rev.slice(0, 30).reduce((s, x) => s + x.v, 0);
  const last30 = rev.slice(30).reduce((s, x) => s + x.v, 0);
  if (prev30 > 0) {
    const delta = (last30 - prev30) / prev30;
    if (delta <= -0.12) push('revenue', 'warning', 'Виручка падає',
      `За останні 30 днів виручка ${Math.round(last30)} грн — на ${Math.round(-delta * 100)}% менше попередніх 30 днів.`,
      'Запустити акцію/реактивацію сплячих клієнтів', Math.round(last30), 'rev_drop_30');
    else if (delta >= 0.15) push('revenue', 'opportunity', 'Виручка зростає',
      `Виручка +${Math.round(delta * 100)}% за 30 днів. Гарний момент підняти середній чек.`,
      'Додати апсейл-послуги / підвищити ціни на топ-послуги', Math.round(last30), 'rev_up_30');
  }

  // 2) Відтік — скільки VIP у зоні ризику
  const churn = await computeChurn(200);
  const highRisk = churn.filter(c => c.band === 'high');
  const vipRisk = highRisk.filter(c => c.total_spent >= 3000);
  if (highRisk.length > 0) push('retention', 'warning', `${highRisk.length} клієнтів у зоні відтоку`,
    `${highRisk.length} клієнтів давно не приходили (з них ${vipRisk.length} VIP). Втрата ≈ ${Math.round(highRisk.reduce((s, c) => s + c.total_spent, 0) / Math.max(1, highRisk.length))} грн/клієнт.`,
    'Надіслати персональну пропозицію топ-10 за пріоритетом', highRisk.length, 'churn_high');

  // 3) No-show рівень
  const ap = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('noshow','cancelled'))::numeric AS bad, COUNT(*)::numeric AS total
       FROM appointments WHERE starts_at >= NOW() - INTERVAL '30 days'`)).rows[0];
  const total = num(ap.total), bad = num(ap.bad);
  if (total >= 20) {
    const rate = bad / total;
    if (rate >= 0.15) push('capacity', 'warning', `Високий рівень неявок: ${Math.round(rate * 100)}%`,
      `${bad} з ${total} записів за 30 днів — неявки/скасування.`,
      'Увімкнути передоплату/нагадування за 24 год', Math.round(rate * 100), 'noshow_high');
  }

  // 4) Завантаження майстрів — дисбаланс
  const mload = (await pool.query(
    `SELECT m.name, COUNT(a.id)::numeric AS cnt
       FROM masters m LEFT JOIN appointments a
         ON a.master_id = m.id AND a.starts_at >= NOW() - INTERVAL '30 days' AND a.status IN ('done','confirmed','booked')
      WHERE m.active = TRUE GROUP BY m.id, m.name ORDER BY cnt DESC`)).rows;
  if (mload.length >= 2) {
    const counts = mload.map(r => num(r.cnt));
    const top = counts[0], bottom = counts[counts.length - 1];
    if (top > 0 && bottom / top < 0.4) push('capacity', 'info', 'Дисбаланс завантаження майстрів',
      `${mload[0].name}: ${top} записів, ${mload[mload.length - 1].name}: ${bottom}. Різниця >2.5×.`,
      'Перерозподілити онлайн-запис / навчання менш завантажених', top, 'master_imbalance');
  }

  // персист (dedup по fingerprint, оновлюємо метрику якщо вже є open/new)
  const saved = [];
  for (const i of insights) {
    const r = await pool.query(
      `INSERT INTO ai_insights (category, severity, title, body, action, metric_value, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (fingerprint) DO UPDATE SET
         metric_value=EXCLUDED.metric_value, body=EXCLUDED.body, severity=EXCLUDED.severity,
         title=EXCLUDED.title, action=EXCLUDED.action
       RETURNING *`,
      [i.category, i.severity, i.title, i.body, i.action, i.metric_value, i.fingerprint]);
    saved.push(r.rows[0]);
  }
  return saved;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Зведення для дашборду AI-04
router.get('/summary', requirePerm('reports.finance'), async (req, res) => {
  try {
    const [churn, anomOpen, insNew] = await Promise.all([
      computeChurn(200),
      pool.query(`SELECT COUNT(*)::int n FROM ai_anomalies WHERE status='open'`),
      pool.query(`SELECT COUNT(*)::int n FROM ai_insights WHERE status='new'`),
    ]);
    const high = churn.filter(c => c.band === 'high');
    const rev = await dailySeries('revenue', 60);
    const prev30 = rev.slice(0, 30).reduce((s, x) => s + x.v, 0);
    const last30 = rev.slice(30).reduce((s, x) => s + x.v, 0);
    res.json({
      churn: { total_analyzed: churn.length, high_risk: high.length, medium_risk: churn.filter(c => c.band === 'medium').length },
      revenue_30d: Math.round(last30), revenue_prev_30d: Math.round(prev30),
      revenue_trend_pct: prev30 > 0 ? Math.round((last30 - prev30) / prev30 * 100) : 0,
      open_anomalies: anomOpen.rows[0].n,
      new_insights: insNew.rows[0].n,
      top_churn: high.slice(0, 5),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Збережені прогнози
router.get('/predictions', requirePerm('reports.finance'), async (req, res) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const r = await pool.query(
      `SELECT * FROM ai_predictions ${kind ? 'WHERE kind=$1' : ''} ORDER BY created_at DESC LIMIT 200`,
      kind ? [kind] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Прогноз відтоку (наживо + персист топ-50)
router.get('/predictions/churn', requirePerm('reports.finance'), async (req, res) => {
  try {
    const limit = Math.min(500, num(req.query.limit, 200));
    const band = req.query.band ? String(req.query.band) : null;
    let churn = await computeChurn(limit);
    if (band) churn = churn.filter(c => c.band === band);
    // персист топ-50 у ai_predictions
    for (const c of churn.slice(0, 50)) {
      await pool.query(
        `INSERT INTO ai_predictions (kind, subject_type, subject_id, value, horizon_days, details)
         VALUES ('churn','client',$1,$2,30,$3)`,
        [c.client_id, c.risk, JSON.stringify({ days_since: c.days_since_visit, cadence: c.cadence_days, band: c.band, name: c.name })]);
    }
    res.json({ count: churn.length, items: churn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Прогноз виручки (проста екстраполяція тренду)
router.get('/predictions/revenue', requirePerm('reports.finance'), async (req, res) => {
  try {
    const horizon = Math.min(90, num(req.query.horizon, 30));
    const series = await dailySeries('revenue', 90);
    const vals = series.map(s => s.v);
    const recent = vals.slice(-30);
    const dailyAvg = mean(recent);
    const trend = mean(vals.slice(-15)) - mean(vals.slice(-30, -15)); // зміна за 15 днів
    const dailyTrend = trend / 15;
    let total = 0; const daily = [];
    for (let i = 1; i <= horizon; i++) {
      const v = Math.max(0, dailyAvg + dailyTrend * i);
      total += v; daily.push(Math.round(v));
    }
    res.json({ horizon, daily_avg: Math.round(dailyAvg), forecast_total: Math.round(total), trend_per_day: Math.round(dailyTrend), daily });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LTV-сегментація
router.get('/predictions/ltv', requirePerm('reports.finance'), async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT c.id, c.name, c.total_spent,
              COUNT(a.id) FILTER (WHERE a.status='done') AS done_visits,
              MIN(a.starts_at) AS first_visit, MAX(a.starts_at) AS last_visit
         FROM clients c LEFT JOIN appointments a ON a.client_id=c.id
        GROUP BY c.id HAVING c.total_spent > 0
        ORDER BY c.total_spent DESC LIMIT 500`)).rows;
    const items = rows.map(r => {
      const spent = num(r.total_spent);
      const first = r.first_visit ? new Date(r.first_visit).getTime() : null;
      const last = r.last_visit ? new Date(r.last_visit).getTime() : null;
      const tenureMonths = first && last ? Math.max(1, (last - first) / DAY_MS / 30) : 1;
      const monthly = spent / tenureMonths;
      // прогнозний LTV на 24 міс (з урахуванням ймовірності утримання ~ done-візити)
      const visits = num(r.done_visits);
      const retention = Math.min(0.95, 0.5 + visits * 0.05);
      const ltv24 = Math.round(monthly * 24 * retention);
      const seg = spent >= 10000 ? 'VIP' : spent >= 3000 ? 'Loyal' : spent >= 500 ? 'Regular' : 'New';
      return { client_id: r.id, name: r.name, total_spent: spent, monthly_value: Math.round(monthly), predicted_ltv_24m: ltv24, segment: seg };
    });
    const summary = {};
    for (const s of ['VIP', 'Loyal', 'Regular', 'New']) {
      const g = items.filter(i => i.segment === s);
      summary[s] = { count: g.length, total_spent: Math.round(g.reduce((a, b) => a + b.total_spent, 0)), avg_ltv: g.length ? Math.round(g.reduce((a, b) => a + b.predicted_ltv_24m, 0) / g.length) : 0 };
    }
    res.json({ summary, items: items.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Аномалії
router.get('/anomalies', requirePerm('reports.finance'), async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const r = await pool.query(
      `SELECT * FROM ai_anomalies ${status ? 'WHERE status=$1' : ''} ORDER BY anomaly_date DESC, id DESC LIMIT 200`,
      status ? [status] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/anomalies/scan', requirePerm('reports.finance'), async (req, res) => {
  try {
    const days = Math.min(180, num(req.body && req.body.days, 60));
    const found = await scanAnomalies(days);
    res.json({ scanned_days: days, found: found.length, items: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/anomalies/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['open', 'acknowledged', 'resolved', 'ignored'].includes(status))
      return res.status(400).json({ error: 'invalid status' });
    const note = req.body && req.body.note != null ? String(req.body.note) : null;
    const r = await pool.query(
      `UPDATE ai_anomalies SET status=$1, note=COALESCE($2,note),
         resolved_at=CASE WHEN $1 IN ('resolved','ignored') THEN NOW() ELSE resolved_at END
       WHERE id=$3 RETURNING *`, [status, note, num(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Інсайти
router.get('/insights', requirePerm('reports.finance'), async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const r = await pool.query(
      `SELECT * FROM ai_insights ${status ? 'WHERE status=$1' : ''} ORDER BY
         CASE severity WHEN 'warning' THEN 0 WHEN 'opportunity' THEN 1 ELSE 2 END, created_at DESC LIMIT 100`,
      status ? [status] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/insights/scan', requirePerm('reports.finance'), async (req, res) => {
  try {
    const saved = await scanInsights();
    res.json({ generated: saved.length, items: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/insights/:id/apply', requirePerm('reports.finance'), async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || 'applied');
    if (!['applied', 'dismissed', 'new'].includes(status))
      return res.status(400).json({ error: 'invalid status' });
    const r = await pool.query(
      `UPDATE ai_insights SET status=$1, applied_at=CASE WHEN $1='applied' THEN NOW() ELSE applied_at END
       WHERE id=$2 RETURNING *`, [status, num(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Топ-рекомендації (з нових інсайтів + критичні аномалії)
router.get('/recommendations', requirePerm('reports.finance'), async (req, res) => {
  try {
    let insights = (await pool.query(`SELECT * FROM ai_insights WHERE status='new' ORDER BY
        CASE severity WHEN 'warning' THEN 0 WHEN 'opportunity' THEN 1 ELSE 2 END, created_at DESC LIMIT 20`)).rows;
    if (insights.length === 0) insights = await scanInsights();
    const anomalies = (await pool.query(
      `SELECT * FROM ai_anomalies WHERE status='open' AND severity IN ('high','medium') ORDER BY anomaly_date DESC LIMIT 10`)).rows;
    const recs = [];
    for (const i of insights) recs.push({ type: 'insight', priority: i.severity === 'warning' ? 1 : 2, title: i.title, action: i.action, category: i.category, id: i.id });
    for (const a of anomalies) recs.push({ type: 'anomaly', priority: a.severity === 'high' ? 0 : 2, title: `${a.direction === 'drop' ? 'Падіння' : 'Сплеск'} «${a.metric}» ${a.anomaly_date}`, action: a.direction === 'drop' ? 'Перевірити причину спаду' : 'Зафіксувати успішний фактор', metric: a.metric, id: a.id });
    recs.sort((x, y) => x.priority - y.priority);
    res.json({ count: recs.length, recommendations: recs.slice(0, 15) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NLP-запит до даних
router.post('/ask', requirePerm('reports.finance'), async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    // Збираємо легкий контекст із реальних даних
    const [rev, churn, anom] = await Promise.all([
      dailySeries('revenue', 30),
      computeChurn(50),
      pool.query(`SELECT metric, anomaly_date, direction, z_score FROM ai_anomalies WHERE status='open' ORDER BY anomaly_date DESC LIMIT 10`),
    ]);
    const rev30 = rev.reduce((s, x) => s + x.v, 0);
    const ctx = {
      revenue_30d: Math.round(rev30),
      avg_daily_revenue: Math.round(rev30 / 30),
      clients_high_churn: churn.filter(c => c.band === 'high').length,
      open_anomalies: anom.rows,
      top_churn: churn.slice(0, 5).map(c => ({ name: c.name, days_since: c.days_since_visit, risk: c.risk })),
    };
    let answer, intent = 'data_qa', success = true;
    if (llm.available && llm.available()) {
      const r = await llm.askJSON(
        `Ти — аналітик б'юті-салону. Дай коротку відповідь українською на питання, спираючись ТІЛЬКИ на дані.
Дані: ${JSON.stringify(ctx)}
Питання: "${question}"
Поверни JSON: {"answer": "...", "intent": "revenue|churn|anomaly|general", "key_numbers": []}`,
        { temperature: 0.2, maxTokens: 500 }).catch(() => null);
      if (r && r.answer) { answer = r; intent = r.intent || intent; }
    }
    if (!answer) {
      // евристичний фолбек без LLM
      answer = { answer: `Виручка за 30 днів: ${ctx.revenue_30d} грн (${ctx.avg_daily_revenue}/день). Клієнтів у зоні відтоку: ${ctx.clients_high_churn}. Відкритих аномалій: ${ctx.open_anomalies.length}.`, intent, key_numbers: [ctx.revenue_30d, ctx.clients_high_churn] };
      success = llm.available && llm.available() ? false : true;
    }
    await pool.query(
      `INSERT INTO ai_nl_queries (user_id, question, intent, answer, success) VALUES ($1,$2,$3,$4,$5)`,
      [req.user && req.user.id ? req.user.id : null, question, intent, JSON.stringify(answer), success]);
    res.json({ question, ...answer, context: ctx });
  } catch (e) {
    await pool.query(`INSERT INTO ai_nl_queries (user_id, question, success) VALUES ($1,$2,FALSE)`,
      [req.user && req.user.id ? req.user.id : null, question]).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
