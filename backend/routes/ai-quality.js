/* routes/ai-quality.js — AI-10 AI Quality Control (повне покриття спеки v2).
   Монтується як /api/ai/quality (шлях зі спеки §API). Працює в tenant-контексті
   (db-pg сам ставить app.tenant_id + RLS, як у quality-control.js).

   Принцип проєкту: важкого ML/LLM немає — Quality Score й NLP рахуються
   ЕВРИСТИКОЮ на РЕАЛЬНИХ даних (appointments, clients, services, reviews).
   Зовнішній LLM-аналіз відгуків — graceful-стаб (lib/llm optional), фолбек —
   keyword-евристика UK/RU. Уся обвязка (зберігання, history, налаштування
   ваг, аналітика, алерти, предиктив) — повноцінна.

   Сутності (спека §БД, таблиці зі 148 + ваги scoring з 174):
     ai_quality_scores      — щоденні snapshot балів (master|admin|branch|service)
     ai_quality_alerts      — спрацьовані алерти
     ai_quality_rules       — правила алертів (настроювані менеджером)
     ai_service_analysis    — NLP-аналіз відгуків/повідомлень
     ai_quality_score_weights — кастомні ваги компонентів Master Score (174)

   Ендпоінти (спека §API):
     GET  /dashboard                       головний дашборд якості (live)
     GET  /scores                          Quality Scores за сутностями (snapshot|live)
     GET  /scores/:entity_type/:entity_id  деталь + history + weak_points + recommendations
     GET  /alerts                          список алертів
     PUT  /alerts/:id/acknowledge          підтвердити отримання
     PUT  /alerts/:id/resolve              закрити / false_positive
     GET  /rules                           список правил
     POST /rules                           створити правило
     PUT  /rules/:id                       оновити правило
     GET  /reviews                         проаналізовані відгуки
     POST /reviews                         додати відгук + NLP-аналіз (стаб/евристика)
     GET  /reviews/analytics               аналітика відгуків (sentiment, aspects, keyword cloud)
     GET  /predictions                     churn / burnout / service_decline (live)
     GET  /comparison                      порівняння філіалів
     GET  /weights                         поточні ваги Master Score
     PUT  /weights                         оновити ваги (ai.quality.config)
     POST /recompute                       матеріалізувати snapshot'и в ai_quality_scores

   Права (спека §RBAC через requirePerm; owner '*' матчить усе; даємо fallback
   на reports.read/reports.finance, бо ai.quality.* може бути не засіяний):
     перегляд          ai.quality.read   (fallback reports.read)
     мутації алертів   ai.quality.write  (fallback reports.read)
     правила           ai.quality.write  (fallback reports.finance)
     ваги scoring      ai.quality.config (fallback reports.finance) */
'use strict';

const express = require('express');
const { getPool } = require('../db-pg');
const { resolveUserByToken, hasPermission, logAction } = require('../lib/rbac');

// Зовнішній LLM — graceful-стаб (дозволено правилом проєкту). Якщо lib/llm
// зʼявиться — підхопиться; інакше NLP рахується keyword-евристикою.
let llmAnalyze = null;
try { const m = require('../lib/llm'); llmAnalyze = m && (m.analyzeReview || m.analyze) || null; } catch { /* optional */ }

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const one = (sql, p = []) => q(sql, p).then(r => r[0] || null);

const num = (v) => (v == null || v === '' ? null : Number(v));
const int = (v, def = null) => { const n = parseInt(v, 10); return Number.isNaN(n) ? def : n; };
const round = (v, d = 1) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const ERR = (res, e, tag) => { console.error(`[ai-quality:${tag}]`, e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); };

const ENTITY_TYPES = ['master', 'admin', 'branch', 'service', 'client'];
const SEVERITIES = ['info', 'warning', 'critical', 'emergency'];
const ALERT_STATUSES = ['active', 'acknowledged', 'resolved', 'false_positive', 'auto_resolved'];
const RULE_TYPES = ['threshold', 'trend', 'anomaly', 'score_drop', 'review_negative'];
const SOURCE_TYPES = ['google_review', 'instagram_comment', 'internal_form', 'telegram', 'chat', 'nps_survey'];
const SENTIMENTS = ['positive', 'neutral', 'negative'];
const LOST = `('cancelled','noshow')`;
const periodDays = (p) => ({ '7d': 7, '30d': 30, '90d': 90 }[p] || 30);

// Дефолтні ваги Master Score (спека §10.03, сума ваг = 100).
const DEFAULT_WEIGHTS = {
  avg_rating: 20, repeat_rate: 20, review_sentiment: 15,
  complaint_rate: 15, on_time: 10, upsell: 10, photo_score: 10,
};

// ── права: будь-яке з перелічених прав дає доступ (OR). Резолвимо юзера сами,
//    бо ai.quality.* може бути не засіяний — тоді працює fallback reports.* ──
function anyPerm(...perms) {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const queryToken = req.method === 'GET' ? req.query.token : undefined;
      const token = bearer || req.headers['x-admin-token'] || queryToken;
      const user = await resolveUserByToken(token);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      if (!perms.some((p) => hasPermission(user.permissions || [], p))) {
        return res.status(403).json({ error: 'forbidden', need: perms });
      }
      req.user = user;
      try { require('../lib/branch-scope').enforceBranch(req); } catch (_) {}
      next();
    } catch (e) {
      console.error('[ai-quality:auth]', e);
      res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
    }
  };
}
const PERM_READ = anyPerm('ai.quality.read', 'reports.read');
const PERM_WRITE = anyPerm('ai.quality.write', 'reports.read');
const PERM_RULES = anyPerm('ai.quality.write', 'reports.finance');
const PERM_CONFIG = anyPerm('ai.quality.config', 'reports.finance');

// ════════════════════════════════════════════════════════════════════════════
// LIVE-ЕВРИСТИКА: метрики майстрів на реальних даних (база Master Score §10.03)
// ════════════════════════════════════════════════════════════════════════════
async function masterLiveMetrics(days = 90) {
  const rows = await q(`
    WITH appt AS (
      SELECT a.master_id, a.client_id, a.service_id, a.status, a.starts_at,
             COALESCE(a.price,0) AS price
        FROM appointments a
       WHERE a.starts_at >= NOW() - ($1 || ' days')::interval
    ),
    agg AS (
      SELECT master_id,
             COUNT(*) FILTER (WHERE status NOT IN ${LOST} AND starts_at <= NOW())::int AS done,
             COUNT(*) FILTER (WHERE status IN ${LOST})::int AS lost,
             COUNT(DISTINCT client_id) FILTER (WHERE status NOT IN ${LOST} AND starts_at <= NOW() AND client_id IS NOT NULL)::int AS uniq_clients,
             COUNT(*) FILTER (WHERE status='confirmed' OR status='done')::int AS confirmed,
             AVG(price) FILTER (WHERE status NOT IN ${LOST} AND price>0)::numeric AS avg_check
        FROM appt GROUP BY master_id
    ),
    returners AS (
      SELECT master_id, COUNT(*)::int AS returning_clients FROM (
        SELECT master_id, client_id FROM appt
         WHERE status NOT IN ${LOST} AND starts_at <= NOW() AND client_id IS NOT NULL
         GROUP BY master_id, client_id HAVING COUNT(*) >= 2) t
       GROUP BY master_id
    ),
    multi AS (
      -- частка візитів (client+date) з >=2 послугами → проксі upsell/cross-sell
      SELECT master_id,
             COUNT(*)::int AS visits,
             COUNT(*) FILTER (WHERE svc >= 2)::int AS multi_visits
        FROM (
          SELECT master_id, client_id, starts_at::date d, COUNT(*) AS svc
            FROM appt WHERE status NOT IN ${LOST} AND starts_at <= NOW() AND client_id IS NOT NULL
           GROUP BY master_id, client_id, starts_at::date) v
       GROUP BY master_id
    ),
    rev AS (
      SELECT master_id::int AS master_id,
             COUNT(*)::int AS reviews,
             AVG(rating)::numeric AS avg_rating,
             COUNT(*) FILTER (WHERE sentiment='negative')::int AS neg,
             COUNT(*) FILTER (WHERE sentiment='positive')::int AS pos
        FROM reviews
       WHERE status NOT IN ('rejected','spam','hidden') AND master_id ~ '^[0-9]+$'
         AND created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY master_id::int
    )
    SELECT m.id, m.name, m.specialty,
           COALESCE(g.done,0) done, COALESCE(g.lost,0) lost,
           COALESCE(g.uniq_clients,0) uniq_clients, COALESCE(g.confirmed,0) confirmed,
           g.avg_check,
           COALESCE(r.returning_clients,0) returning_clients,
           COALESCE(mu.visits,0) visits, COALESCE(mu.multi_visits,0) multi_visits,
           COALESCE(rv.reviews,0) reviews, rv.avg_rating,
           COALESCE(rv.neg,0) neg_reviews, COALESCE(rv.pos,0) pos_reviews
      FROM masters m
      LEFT JOIN agg g       ON g.master_id=m.id
      LEFT JOIN returners r  ON r.master_id=m.id
      LEFT JOIN multi mu     ON mu.master_id=m.id
      LEFT JOIN rev rv       ON rv.master_id=m.id
     WHERE m.active=true
     ORDER BY done DESC`, [days]).catch(() => []);
  return rows;
}

// Перетворює сирі метрики майстра у компоненти Master Score з урахуванням ваг.
function scoreMaster(r, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const total = Object.values(w).reduce((s, x) => s + Number(x || 0), 0) || 100;
  const done = Number(r.done) || 0;
  const lost = Number(r.lost) || 0;
  const retention = r.uniq_clients ? r.returning_clients / r.uniq_clients : 0;        // 0..1
  const reliability = (done + lost) ? done / (done + lost) : 1;                        // on_time proxy
  const sentiment = r.reviews >= 1                                                     // -1..1 → 0..1
    ? ((r.pos_reviews - r.neg_reviews) / r.reviews + 1) / 2
    : 0.6;
  const ratingNorm = r.avg_rating != null ? Number(r.avg_rating) / 5 : 0.7;            // 0..1
  const complaintFree = (done + r.neg_reviews) ? 1 - r.neg_reviews / (done + r.neg_reviews) : 1;
  const upsell = r.visits ? r.multi_visits / r.visits : 0;                             // 0..1
  const photo = null;                                                                  // AI photo не підключений → виключаємо з суми

  const parts = {
    avg_rating: ratingNorm * w.avg_rating,
    repeat_rate: retention * w.repeat_rate,
    review_sentiment: sentiment * w.review_sentiment,
    complaint_rate: complaintFree * w.complaint_rate,
    on_time: reliability * w.on_time,
    upsell: upsell * w.upsell,
  };
  if (photo != null) parts.photo_score = photo * w.photo_score;
  // нормалізуємо на фактичну суму використаних ваг (без photo) → 0..100
  const usedWeight = total - (photo == null ? w.photo_score : 0);
  const raw = Object.values(parts).reduce((s, x) => s + x, 0);
  const overall = usedWeight > 0 ? Math.round((raw / usedWeight) * 100 * 100) / 100 : 0;
  const components = {};
  for (const [k, v] of Object.entries(parts)) components[k] = round(v, 1);
  return {
    overall_score: overall,
    components,
    extra: {
      done, lost, reviews: r.reviews,
      retention_pct: Math.round(retention * 100),
      cancel_pct: (done + lost) ? Math.round((lost / (done + lost)) * 100) : 0,
      avg_rating: r.avg_rating != null ? round(r.avg_rating, 1) : null,
      neg_reviews: r.neg_reviews,
      upsell_pct: Math.round(upsell * 100),
      avg_check: r.avg_check != null ? Math.round(Number(r.avg_check)) : null,
    },
  };
}

// Поточні ваги (кастомні або дефолт). branch_id опційно.
async function getWeights(branchId = null) {
  const row = await one(
    `SELECT weights FROM ai_quality_score_weights
      WHERE tenant_id=current_tenant_id() AND ($1::int IS NULL OR branch_id=$1)
      ORDER BY branch_id NULLS LAST LIMIT 1`, [branchId]).catch(() => null);
  return { ...DEFAULT_WEIGHTS, ...((row && row.weights) || {}) };
}

// Бранч-метрики live (NPS/CSAT/wait/no-show) з reviews+appointments.
async function branchLiveMetrics(days = 30, branchId = null) {
  const since = `NOW() - ($1 || ' days')::interval`;
  const appt = await one(`
    SELECT COUNT(*) FILTER (WHERE status NOT IN ${LOST})::int done,
           COUNT(*) FILTER (WHERE status='noshow')::int noshows,
           COUNT(*) FILTER (WHERE status='cancelled')::int cancels,
           COUNT(*)::int total
      FROM appointments
     WHERE starts_at >= ${since} AND starts_at <= NOW()`, [days]).catch(() => ({}));
  const rev = await one(`
    SELECT COUNT(*)::int reviews, AVG(rating)::numeric csat,
           COUNT(*) FILTER (WHERE rating>=4)::int promoters,
           COUNT(*) FILTER (WHERE rating<=2)::int detractors
      FROM reviews
     WHERE status NOT IN ('rejected','spam','hidden') AND created_at >= ${since}`, [days]).catch(() => ({}));
  // repeat visit rate: клієнти з >=2 завершеними візитами за вікно
  const repeat = await one(`
    WITH cv AS (
      SELECT client_id, COUNT(*) n FROM appointments
       WHERE status NOT IN ${LOST} AND starts_at <= NOW() AND starts_at >= ${since} AND client_id IS NOT NULL
       GROUP BY client_id)
    SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE n>=2)::int repeat FROM cv`, [days]).catch(() => ({}));
  const a = appt || {}; const r = rev || {}; const rp = repeat || {};
  const reviews = Number(r.reviews) || 0;
  const nps = reviews ? round(((Number(r.promoters) - Number(r.detractors)) / reviews) * 100, 1) : null; // -100..100
  const npsScaled = nps == null ? null : round(nps / 10 + 0, 1) <= -10 ? -10 : round((nps + 100) / 20, 1); // приблизно 0..10
  return {
    appointments_done: a.done || 0,
    no_show_rate: a.total ? round((a.noshows / a.total) * 100, 1) : 0,
    cancel_rate: a.total ? round((a.cancels / a.total) * 100, 1) : 0,
    csat: r.csat != null ? round(r.csat, 2) : null,
    nps: npsScaled,
    nps_raw: nps,
    reviews,
    repeat_visit_rate: rp.total ? round((rp.repeat / rp.total) * 100, 1) : 0,
    // wait_time/first_contact беремо з NLP-сигналів (нема таймстемпів ресепшн у схемі)
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NLP-ЕВРИСТИКА (10.01) — keyword-based sentiment/aspect/emotion/urgency, UK/RU.
// Зовнішній LLM (llmAnalyze) використовується, якщо доступний; інакше — це фолбек.
// ════════════════════════════════════════════════════════════════════════════
const LEX = {
  positive: ['дякую', 'чудов', 'найкращ', 'супер', 'задоволен', 'рекоменд', 'люблю', 'класн', 'прекрасн', 'професіонал', 'уважн', 'затишн', 'спасибо', 'отличн', 'довольн', 'нравится', 'вежлив', 'приємн', 'вдячн', 'топ', 'ідеальн'],
  negative: ['жах', 'погано', 'розчарув', 'грубо', 'хамств', 'брудно', 'неякісн', 'обман', 'скарг', 'ніколи', 'зіпсув', 'обурен', 'ужасно', 'плохо', 'грязно', 'хамят', 'разочаров', 'недовол', 'испортил', 'кошмар', 'не рекоменд', 'зливаю', 'верніть гроші', 'верните деньги'],
  emotions: {
    gratitude: ['дякую', 'вдячн', 'спасибо', 'благодар'],
    satisfaction: ['задоволен', 'довольн', 'класно', 'супер'],
    joy: ['радість', 'щасл', 'обожн'],
    disappointment: ['розчарув', 'разочаров', 'шкода', 'жаль'],
    anger: ['обурен', 'гнів', 'хамств', 'хамят', 'возмущ', 'злюсь'],
  },
  aspects: {
    master: ['майстер', 'майстра', 'мастер', 'колорист', 'перукар', 'стиліст', 'манікюрниц', 'косметолог'],
    service: ['послуг', 'процедур', 'фарбуван', 'окрашиван', 'стрижк', 'манікюр', 'педикюр', 'макіяж'],
    cleanliness: ['чисто', 'брудно', 'грязно', 'стерильн', 'гігієн'],
    wait_time: ['чекал', 'чекати', 'очікуван', 'ждал', 'ожидан', 'запізн', 'спізн', 'опоздал', 'затримк'],
    price: ['ціна', 'дорого', 'дешево', 'вартість', 'цена', 'переплат', 'кошту'],
    atmosphere: ['атмосфер', 'затишн', 'музик', 'інтерʼєр', 'уютн', 'обстановк'],
  },
  urgency: ['скандал', 'суд', 'поліц', 'верніть гроші', 'верните деньги', 'напишу скаргу', 'напишу жалобу', 'наклеп', 'отзыв везде', 'розповім усім'],
};

function heuristicNLP(text) {
  const t = (text || '').toLowerCase();
  let pos = 0, neg = 0;
  for (const w of LEX.positive) if (t.includes(w)) pos++;
  for (const w of LEX.negative) if (t.includes(w)) neg++;
  const total = pos + neg;
  let score = total ? (pos - neg) / total : 0;
  score = Math.max(-1, Math.min(1, +score.toFixed(2)));
  const sentiment = score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral';

  const emotions = [];
  for (const [emo, kws] of Object.entries(LEX.emotions)) if (kws.some((k) => t.includes(k))) emotions.push(emo);

  const aspects = [];
  for (const [asp, kws] of Object.entries(LEX.aspects)) {
    if (kws.some((k) => t.includes(k))) {
      // локальний sentiment аспекту: якщо поряд негатив-слово → negative
      const asentiment = LEX.negative.some((n) => t.includes(n)) && (asp === 'wait_time' || asp === 'cleanliness')
        ? 'negative' : sentiment;
      aspects.push({ aspect: asp, sentiment: asentiment, text: null });
    }
  }

  const urgentHit = LEX.urgency.some((k) => t.includes(k));
  const urgency = urgentHit ? 'critical' : (sentiment === 'negative' && neg >= 2 ? 'high' : 'normal');
  const isActionable = sentiment === 'negative' || urgency !== 'normal';

  return { sentiment, sentiment_score: score, aspects, emotions, urgency, is_actionable: isActionable };
}

function suggestResponse(nlp, text) {
  if (nlp.sentiment === 'positive') {
    return 'Щиро дякуємо за теплий відгук! Нам дуже приємно, що вам сподобалось — чекаємо знову.';
  }
  if (nlp.sentiment === 'negative') {
    const aspectMap = {
      wait_time: 'час очікування', cleanliness: 'чистоту', master: 'роботу майстра',
      service: 'якість послуги', price: 'питання вартості', atmosphere: 'атмосферу',
    };
    const issues = nlp.aspects.filter((a) => a.sentiment === 'negative').map((a) => aspectMap[a.aspect]).filter(Boolean);
    const what = issues.length ? ` щодо ${issues.join(', ')}` : '';
    return `Нам дуже шкода, що ваш візит не виправдав очікувань${what}. Будь ласка, напишіть нам у приватні повідомлення — ми розберемось і виправимо ситуацію. Ваша думка важлива.`;
  }
  return 'Дякуємо за відгук! Якщо є побажання — будемо раді почути, щоб стати кращими.';
}

async function analyzeText(text) {
  if (llmAnalyze) {
    try {
      const r = await llmAnalyze(text);
      if (r && r.sentiment) return { ...heuristicNLP(text), ...r, _engine: 'llm' };
    } catch (e) { console.warn('[ai-quality:llm] fallback to heuristic:', e.message); }
  }
  return { ...heuristicNLP(text), _engine: 'heuristic' };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /dashboard — головний дашборд (live + snapshot-доповнення)
// ?branch_id=&period=7d|30d|90d
// ════════════════════════════════════════════════════════════════════════════
router.get('/dashboard', PERM_READ, async (req, res) => {
  try {
    const days = periodDays(req.query.period);
    const branchId = num(req.query.branch_id);
    const since = `NOW() - INTERVAL '${days} days'`;

    const [bm, masters, sentiment, alerts, weights] = await Promise.all([
      branchLiveMetrics(days, branchId),
      masterLiveMetrics(Math.max(days, 90)),
      one(`SELECT ROUND(AVG(sentiment_score)::numeric,3) avg_s,
                  COUNT(*) FILTER (WHERE sentiment='positive')::int pos,
                  COUNT(*) FILTER (WHERE sentiment='neutral')::int neu,
                  COUNT(*) FILTER (WHERE sentiment='negative')::int neg,
                  COUNT(*)::int total
             FROM ai_service_analysis
            WHERE tenant_id=current_tenant_id() AND created_at >= ${since}`).catch(() => ({})),
      one(`SELECT COUNT(*)::int active,
                  COUNT(*) FILTER (WHERE severity IN ('critical','emergency'))::int crit
             FROM ai_quality_alerts
            WHERE tenant_id=current_tenant_id() AND status='active'`).catch(() => ({})),
      getWeights(branchId),
    ]);

    // branch_score = середній Master Score (live)
    const scored = masters.filter((m) => m.done >= 5).map((m) => scoreMaster(m, weights).overall_score);
    const branchScore = scored.length ? round(scored.reduce((s, x) => s + x, 0) / scored.length, 1) : null;

    // trend: branch_score vs попередні snapshot'и (якщо є)
    const prevSnap = await one(
      `SELECT overall_score FROM ai_quality_scores
        WHERE tenant_id=current_tenant_id() AND entity_type='branch'
          AND score_date < CURRENT_DATE ORDER BY score_date DESC LIMIT 1`).catch(() => null);
    const scoreTrend = (prevSnap && branchScore != null)
      ? round(branchScore - Number(prevSnap.overall_score), 1) : null;

    res.json({
      ok: true,
      period_days: days,
      branch_id: branchId,
      branch_score: branchScore,
      nps: bm.nps,
      nps_raw: bm.nps_raw,
      csat: bm.csat,
      avg_wait_time_min: null, // нема таймстемпів ресепшн у схемі → null (чесно)
      no_show_rate: bm.no_show_rate,
      cancel_rate: bm.cancel_rate,
      complaint_rate: sentiment && sentiment.total ? round((sentiment.neg / Math.max(bm.appointments_done, 1)) * 100, 2) : 0,
      first_contact_resolution: null,
      repeat_visit_rate: bm.repeat_visit_rate,
      sentiment_avg: sentiment && sentiment.avg_s != null ? +sentiment.avg_s : null,
      sentiment_distribution: {
        positive: (sentiment && sentiment.pos) || 0,
        neutral: (sentiment && sentiment.neu) || 0,
        negative: (sentiment && sentiment.neg) || 0,
        total: (sentiment && sentiment.total) || 0,
      },
      active_alerts_count: (alerts && alerts.active) || 0,
      critical_alerts_count: (alerts && alerts.crit) || 0,
      masters_evaluated: scored.length,
      trends: { score: scoreTrend, nps: null, csat: null, sentiment: null },
    });
  } catch (e) { ERR(res, e, 'dashboard'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /scores — Quality Scores за сутностями (live-обчислення майстрів + snapshot fallback)
// ?branch_id=&entity_type=master|admin|branch|service&sort=score_asc|score_desc&period=&page=&per_page=
// ════════════════════════════════════════════════════════════════════════════
router.get('/scores', PERM_READ, async (req, res) => {
  try {
    const days = periodDays(req.query.period);
    const entityType = ENTITY_TYPES.includes(req.query.entity_type) ? req.query.entity_type : 'master';
    const sortAsc = req.query.sort === 'score_asc';
    const limit = Math.min(200, int(req.query.per_page, 50));
    const page = Math.max(1, int(req.query.page, 1));
    const branchId = num(req.query.branch_id);

    let items = [];
    if (entityType === 'master') {
      const weights = await getWeights(branchId);
      const metrics = await masterLiveMetrics(Math.max(days, 90));
      items = metrics.filter((m) => m.done >= 3).map((m) => {
        const sc = scoreMaster(m, weights);
        return {
          entity_id: m.id, entity_name: m.name, entity_type: 'master',
          overall_score: sc.overall_score, components: sc.components,
          trend: null, trend_delta: null, meta: sc.extra,
        };
      });
    } else {
      // admin/branch/service: беремо останній snapshot з ai_quality_scores
      const rows = await q(
        `SELECT DISTINCT ON (entity_id) entity_id, overall_score, components, trend, trend_delta, score_date
           FROM ai_quality_scores
          WHERE tenant_id=current_tenant_id() AND entity_type=$1
            AND score_date >= CURRENT_DATE - ($2 || ' days')::interval
          ORDER BY entity_id, score_date DESC`, [entityType, days]).catch(() => []);
      items = rows.map((r) => ({
        entity_id: r.entity_id, entity_name: null, entity_type: entityType,
        overall_score: +r.overall_score, components: r.components,
        trend: r.trend, trend_delta: r.trend_delta != null ? +r.trend_delta : null,
      }));
    }

    items.sort((a, b) => sortAsc ? a.overall_score - b.overall_score : b.overall_score - a.overall_score);
    const total = items.length;
    const paged = items.slice((page - 1) * limit, (page - 1) * limit + limit);
    res.json({ ok: true, items: paged, total, page, per_page: limit });
  } catch (e) { ERR(res, e, 'scores'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /scores/:entity_type/:entity_id — деталь + history + weak_points + recommendations
// ?from=&to=
// ════════════════════════════════════════════════════════════════════════════
router.get('/scores/:entity_type/:entity_id', PERM_READ, async (req, res) => {
  try {
    const { entity_type, entity_id } = req.params;
    if (!ENTITY_TYPES.includes(entity_type)) return res.status(400).json({ error: 'invalid_entity_type' });

    // history зі snapshot'ів
    const w = ['tenant_id=current_tenant_id()', 'entity_type=$1', 'entity_id=$2'];
    const p = [entity_type, String(entity_id)];
    if (req.query.from) { p.push(req.query.from); w.push(`score_date>=$${p.length}`); }
    if (req.query.to) { p.push(req.query.to); w.push(`score_date<=$${p.length}`); }
    const history = await q(
      `SELECT score_date, overall_score, components, trend, trend_delta, benchmark_own, benchmark_network
         FROM ai_quality_scores WHERE ${w.join(' AND ')}
        ORDER BY score_date DESC LIMIT 90`, p).catch(() => []);

    // поточний бал: для майстра рахуємо live, інакше — останній snapshot
    let current = null, components = {}, extra = {}, entityName = null;
    if (entity_type === 'master') {
      const weights = await getWeights(null);
      const metrics = await masterLiveMetrics(90);
      const m = metrics.find((x) => String(x.id) === String(entity_id));
      if (m) {
        const sc = scoreMaster(m, weights);
        current = sc.overall_score; components = sc.components; extra = sc.extra; entityName = m.name;
      }
    }
    if (current == null && history.length) {
      current = +history[0].overall_score; components = history[0].components || {};
    }
    if (current == null) return res.status(404).json({ error: 'no_data', message: 'Недостатньо даних по сутності.' });

    if (entityName == null) {
      if (entity_type === 'master') entityName = (await one(`SELECT name FROM masters WHERE id=$1`, [int(entity_id)]).catch(() => null))?.name || null;
      else if (entity_type === 'service') entityName = (await one(`SELECT name FROM services WHERE id=$1`, [int(entity_id)]).catch(() => null))?.name || null;
    }

    // weak_points: компоненти з найнижчим відносним балом
    const weights = await getWeights(null);
    const weakPoints = Object.entries(components)
      .map(([k, v]) => ({ metric: k, value: Number(v), pct: weights[k] ? Math.round((Number(v) / weights[k]) * 100) : null }))
      .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999)).slice(0, 3);

    // recommendations за слабкими місцями
    const RECO = {
      avg_rating: 'Середня оцінка нижча за норму — провести розбір негативних візитів, можливо аттестацію.',
      repeat_rate: 'Низька повертаність клієнтів — налаштувати win-back, нагадування, програму лояльності.',
      review_sentiment: 'Негативний тон у відгуках — опрацювати скарги, відповісти на негатив публічно.',
      complaint_rate: 'Підвищений рівень скарг — перевірити технологію/матеріали, провести 1:1 з майстром.',
      on_time: 'Багато відмін/неявок — перевірити розклад, ввести підтвердження бронювань.',
      upsell: 'Низький допродаж — навчити майстра рекомендувати супутні послуги/догляд.',
      photo_score: 'Низький бал AI-фотоконтролю — звернути увагу на якість виконання робіт.',
    };
    const recommendations = weakPoints.map((wp) => RECO[wp.metric]).filter(Boolean);

    const benchmarkOwn = history.length
      ? round(history.reduce((s, h) => s + Number(h.overall_score), 0) / history.length, 2) : null;

    res.json({
      ok: true,
      entity_type, entity_id: String(entity_id), entity_name: entityName,
      current_score: current, components, meta: extra,
      history: history.map((h) => ({ date: h.score_date, score: +h.overall_score, trend: h.trend })),
      benchmark_own: benchmarkOwn,
      benchmark_network: history.length && history[0].benchmark_network != null ? +history[0].benchmark_network : null,
      weak_points: weakPoints,
      recommendations,
    });
  } catch (e) { ERR(res, e, 'score_detail'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /alerts — список алертів
// ?branch_id=&status=&severity=&entity_type=&page=&per_page=
// ════════════════════════════════════════════════════════════════════════════
router.get('/alerts', PERM_READ, async (req, res) => {
  try {
    const limit = Math.min(200, int(req.query.per_page, 50));
    const page = Math.max(1, int(req.query.page, 1));
    const w = ['a.tenant_id=current_tenant_id()']; const p = [];
    const add = (cond, val) => { p.push(val); w.push(cond.replace('?', '$' + p.length)); };
    if (req.query.branch_id) add('a.branch_id=?', num(req.query.branch_id));
    if (ALERT_STATUSES.includes(req.query.status)) add('a.status=?', req.query.status);
    if (SEVERITIES.includes(req.query.severity)) add('a.severity=?', req.query.severity);
    if (ENTITY_TYPES.includes(req.query.entity_type)) add('a.entity_type=?', req.query.entity_type);
    const where = w.join(' AND ');

    p.push(limit); const li = p.length;
    p.push((page - 1) * limit); const oi = p.length;
    const [items, totals] = await Promise.all([
      q(`SELECT a.id, a.title, a.severity, a.entity_type, a.entity_id, a.metric_name,
                a.metric_value, a.threshold_value, a.status, a.recommended_actions,
                a.created_at, a.acknowledged_at, a.resolved_at
           FROM ai_quality_alerts a WHERE ${where}
          ORDER BY (a.status='active') DESC,
                   CASE a.severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                   a.created_at DESC
          LIMIT $${li} OFFSET $${oi}`, p),
      one(`SELECT COUNT(*)::int total,
                  COUNT(*) FILTER (WHERE status='active')::int active_count
             FROM ai_quality_alerts a WHERE ${where}`, p.slice(0, p.length - 2)),
    ]);
    res.json({
      ok: true,
      items: items.map((a) => ({ ...a, metric_value: a.metric_value != null ? +a.metric_value : null, threshold_value: a.threshold_value != null ? +a.threshold_value : null })),
      total: totals ? totals.total : items.length,
      active_count: totals ? totals.active_count : 0,
      page, per_page: limit,
    });
  } catch (e) { ERR(res, e, 'alerts'); }
});

// ── PUT /alerts/:id/acknowledge ─────────────────────────────────────────────
router.put('/alerts/:id/acknowledge', PERM_WRITE, async (req, res) => {
  try {
    const id = int(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const actionPlan = (req.body || {}).action_plan || null;
    const uid = req.user ? req.user.id : null;
    const row = await one(
      `UPDATE ai_quality_alerts
          SET status='acknowledged', acknowledged_by=$2, acknowledged_at=NOW(),
              action_plan=COALESCE($3, action_plan)
        WHERE id=$1 AND tenant_id=current_tenant_id() AND status='active'
        RETURNING id, status`, [id, uid, actionPlan]);
    if (!row) return res.status(404).json({ error: 'not_found_or_not_active' });
    logAction({ user: req.user, action: 'ai_quality.alert.acknowledge', entity: 'ai_quality_alert', entity_id: id }).catch(() => {});
    res.json({ ok: true, id: row.id, status: row.status });
  } catch (e) { ERR(res, e, 'alert_ack'); }
});

// ── PUT /alerts/:id/resolve ─────────────────────────────────────────────────
router.put('/alerts/:id/resolve', PERM_WRITE, async (req, res) => {
  try {
    const id = int(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const b = req.body || {};
    const newStatus = b.is_false_positive ? 'false_positive' : 'resolved';
    const note = b.resolution_note || null;
    const row = await one(
      `UPDATE ai_quality_alerts
          SET status=$2, resolved_at=NOW(),
              action_plan=COALESCE($3, action_plan)
        WHERE id=$1 AND tenant_id=current_tenant_id()
          AND status IN ('active','acknowledged')
        RETURNING id, status`, [id, newStatus, note]);
    if (!row) return res.status(404).json({ error: 'not_found_or_closed' });
    logAction({ user: req.user, action: 'ai_quality.alert.resolve', entity: 'ai_quality_alert', entity_id: id, meta: { status: newStatus } }).catch(() => {});
    res.json({ ok: true, id: row.id, status: row.status });
  } catch (e) { ERR(res, e, 'alert_resolve'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /rules — правила алертів
// ════════════════════════════════════════════════════════════════════════════
router.get('/rules', PERM_READ, async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.branch_id) { p.push(num(req.query.branch_id)); w.push(`(branch_id=$${p.length} OR branch_id IS NULL)`); }
    if (req.query.is_enabled != null) { p.push(req.query.is_enabled === 'true' || req.query.is_enabled === true); w.push(`is_enabled=$${p.length}`); }
    const rules = await q(
      `SELECT id, branch_id, name, rule_type AS type, metric, entity_type, condition_json AS condition,
              severity, cooldown_hours, escalation_chain, is_enabled, triggers_count, last_triggered_at, created_at
         FROM ai_quality_rules WHERE ${w.join(' AND ')}
        ORDER BY is_enabled DESC, id DESC`, p).catch(() => []);
    res.json({ ok: true, rules });
  } catch (e) { ERR(res, e, 'rules'); }
});

// ── POST /rules — створити правило ──────────────────────────────────────────
router.post('/rules', PERM_RULES, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    const type = RULE_TYPES.includes(b.type) ? b.type : 'threshold';
    if (!b.metric) return res.status(400).json({ error: 'metric_required' });
    const severity = SEVERITIES.includes(b.severity) ? b.severity : 'warning';
    const uid = req.user ? req.user.id : null;
    const row = await one(
      `INSERT INTO ai_quality_rules
         (branch_id, name, rule_type, metric, entity_type, condition_json, severity,
          cooldown_hours, escalation_chain, is_enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,COALESCE($10,true),$11)
       RETURNING id, name`,
      [b.branch_id || null, b.name, type, b.metric,
       ENTITY_TYPES.includes(b.entity_type) ? b.entity_type : null,
       JSON.stringify(b.condition || {}), severity,
       int(b.cooldown_hours, 24), JSON.stringify(b.escalation_chain || []),
       b.is_enabled, uid]);
    logAction({ user: req.user, action: 'ai_quality.rule.create', entity: 'ai_quality_rule', entity_id: row.id }).catch(() => {});
    res.json({ ok: true, id: row.id, name: row.name });
  } catch (e) { ERR(res, e, 'rule_create'); }
});

// ── PUT /rules/:id — оновити правило ────────────────────────────────────────
router.put('/rules/:id', PERM_RULES, async (req, res) => {
  try {
    const id = int(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const b = req.body || {};
    const sets = []; const p = [];
    const set = (col, val, cast = '') => { p.push(val); sets.push(`${col}=$${p.length}${cast}`); };
    if ('name' in b) set('name', b.name);
    if ('condition' in b) set('condition_json', JSON.stringify(b.condition || {}), '::jsonb');
    if ('severity' in b && SEVERITIES.includes(b.severity)) set('severity', b.severity);
    if ('cooldown_hours' in b) set('cooldown_hours', int(b.cooldown_hours, 24));
    if ('escalation_chain' in b) set('escalation_chain', JSON.stringify(b.escalation_chain || []), '::jsonb');
    if ('is_enabled' in b) set('is_enabled', !!b.is_enabled);
    if ('metric' in b) set('metric', b.metric);
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    sets.push('updated_at=NOW()');
    p.push(id);
    const row = await one(
      `UPDATE ai_quality_rules SET ${sets.join(', ')}
        WHERE id=$${p.length} AND tenant_id=current_tenant_id()
        RETURNING id, name, is_enabled`, p);
    if (!row) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'ai_quality.rule.update', entity: 'ai_quality_rule', entity_id: id }).catch(() => {});
    res.json({ ok: true, rule: row });
  } catch (e) { ERR(res, e, 'rule_update'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /reviews — проаналізовані відгуки
// ?branch_id=&source_type=&sentiment=&urgency=&is_actionable=&from=&to=&page=&per_page=
// ════════════════════════════════════════════════════════════════════════════
router.get('/reviews', PERM_READ, async (req, res) => {
  try {
    const limit = Math.min(200, int(req.query.per_page, 50));
    const page = Math.max(1, int(req.query.page, 1));
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (cond, val) => { p.push(val); w.push(cond.replace('?', '$' + p.length)); };
    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (SOURCE_TYPES.includes(req.query.source_type)) add('source_type=?', req.query.source_type);
    if (SENTIMENTS.includes(req.query.sentiment)) add('sentiment=?', req.query.sentiment);
    if (['high', 'critical', 'normal'].includes(req.query.urgency)) add('urgency=?', req.query.urgency);
    if (req.query.is_actionable === 'true') w.push('is_actionable=TRUE');
    if (req.query.from) add('created_at>=?::date', req.query.from);
    if (req.query.to) add('created_at<(?::date + INTERVAL \'1 day\')', req.query.to);
    const where = w.join(' AND ');
    p.push(limit); const li = p.length; p.push((page - 1) * limit); const oi = p.length;
    const [items, total] = await Promise.all([
      q(`SELECT id, source_type, source_url, client_id, raw_text, language, sentiment,
                sentiment_score, aspects, entities, emotions, urgency, is_actionable,
                suggested_response, created_at
           FROM ai_service_analysis WHERE ${where}
          ORDER BY (urgency='critical') DESC, (urgency='high') DESC, created_at DESC
          LIMIT $${li} OFFSET $${oi}`, p),
      one(`SELECT COUNT(*)::int n FROM ai_service_analysis WHERE ${where}`, p.slice(0, p.length - 2)),
    ]);
    res.json({
      ok: true,
      items: items.map((r) => ({ ...r, sentiment_score: r.sentiment_score != null ? +r.sentiment_score : null })),
      total: total ? total.n : items.length, page, per_page: limit,
    });
  } catch (e) { ERR(res, e, 'reviews'); }
});

// ── POST /reviews — додати відгук + NLP-аналіз (LLM-стаб / евристика) ────────
router.post('/reviews', PERM_WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.raw_text || !String(b.raw_text).trim()) return res.status(400).json({ error: 'raw_text_required' });
    const sourceType = SOURCE_TYPES.includes(b.source_type) ? b.source_type : 'internal_form';
    const nlp = await analyzeText(b.raw_text);
    const suggested = nlp.suggested_response || suggestResponse(nlp, b.raw_text);
    // entities: спробуємо знайти імена майстрів у тексті (евристика по masters.name)
    let entities = b.entities || {};
    if (!entities.master_names) {
      const masters = await q(`SELECT name FROM masters WHERE active=true`).catch(() => []);
      const lower = String(b.raw_text).toLowerCase();
      const found = masters.map((m) => m.name).filter((n) => n && lower.includes(String(n).toLowerCase().split(' ')[0]));
      if (found.length) entities = { ...entities, master_names: found };
    }
    const row = await one(
      `INSERT INTO ai_service_analysis
         (branch_id, source_type, source_id, source_url, client_id, raw_text, language,
          sentiment, sentiment_score, aspects, entities, emotions, urgency,
          is_actionable, suggested_response)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'uk'),$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)
       RETURNING id, sentiment, sentiment_score, urgency, is_actionable, suggested_response`,
      [b.branch_id || null, sourceType, b.source_id || null, b.source_url || null,
       b.client_id || null, b.raw_text, b.language || null,
       nlp.sentiment, nlp.sentiment_score, JSON.stringify(nlp.aspects || []),
       JSON.stringify(entities || {}), JSON.stringify(nlp.emotions || []),
       nlp.urgency, nlp.is_actionable, suggested]);

    // якщо negative+actionable → опційно фіксуємо алерт (review_negative)
    if (nlp.is_actionable && nlp.sentiment === 'negative') {
      await q(
        `INSERT INTO ai_quality_alerts
           (branch_id, entity_type, entity_id, severity, title, description,
            metric_name, recommended_actions, status)
         VALUES ($1,'branch',$2,$3,$4,$5,'review_negative',$6::jsonb,'active')`,
        [b.branch_id || null, String(b.branch_id || 0),
         nlp.urgency === 'critical' ? 'critical' : 'warning',
         `Негативний відгук (${sourceType})`,
         String(b.raw_text).slice(0, 500),
         JSON.stringify(['Відповісти на відгук', 'Звʼязатись з клієнтом'])]
      ).catch(() => {});
    }
    res.json({ ok: true, analysis: { ...row, engine: nlp._engine } });
  } catch (e) { ERR(res, e, 'review_create'); }
});

// ── GET /reviews/analytics — аналітика відгуків ─────────────────────────────
router.get('/reviews/analytics', PERM_READ, async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.branch_id) { p.push(num(req.query.branch_id)); w.push(`branch_id=$${p.length}`); }
    if (req.query.from) { p.push(req.query.from); w.push(`created_at>=$${p.length}::date`); }
    if (req.query.to) { p.push(req.query.to); w.push(`created_at<($${p.length}::date + INTERVAL '1 day')`); }
    const where = w.join(' AND ');

    const [dist, bySource, weekly, rows] = await Promise.all([
      one(`SELECT COUNT(*)::int total,
                  COUNT(*) FILTER (WHERE sentiment='positive')::int pos,
                  COUNT(*) FILTER (WHERE sentiment='neutral')::int neu,
                  COUNT(*) FILTER (WHERE sentiment='negative')::int neg,
                  ROUND(AVG(sentiment_score)::numeric,3) avg_s
             FROM ai_service_analysis WHERE ${where}`, p),
      q(`SELECT source_type, COUNT(*)::int cnt, ROUND(AVG(sentiment_score)::numeric,3) avg_s
           FROM ai_service_analysis WHERE ${where} GROUP BY source_type ORDER BY cnt DESC`, p),
      q(`SELECT to_char(date_trunc('week', created_at),'YYYY-MM-DD') wk,
                COUNT(*)::int cnt, ROUND(AVG(sentiment_score)::numeric,3) avg_s
           FROM ai_service_analysis WHERE ${where}
          GROUP BY 1 ORDER BY 1`, p),
      q(`SELECT raw_text, sentiment, aspects, entities FROM ai_service_analysis WHERE ${where} LIMIT 2000`, p),
    ]);

    // aspect-аналітика + keyword cloud (JS-агрегація)
    const aspectStat = {}; const posWords = {}; const negWords = {}; const byMaster = {};
    const STOP = new Set(['це', 'що', 'як', 'для', 'дуже', 'був', 'була', 'мене', 'мені', 'так', 'все', 'там', 'тут', 'на', 'до', 'але', 'или', 'это', 'был', 'была', 'очень', 'меня', 'мне', 'там', 'все', 'или', 'and', 'the', 'що', 'не', 'я', 'в', 'і', 'з', 'а', 'у', 'та', 'по', 'до', 'за']);
    for (const r of rows) {
      for (const a of (r.aspects || [])) {
        const k = a.aspect; aspectStat[k] = aspectStat[k] || { aspect: k, positive: 0, negative: 0, neutral: 0 };
        aspectStat[k][a.sentiment === 'negative' ? 'negative' : a.sentiment === 'positive' ? 'positive' : 'neutral']++;
      }
      const bucket = r.sentiment === 'negative' ? negWords : r.sentiment === 'positive' ? posWords : null;
      if (bucket) for (const word of String(r.raw_text || '').toLowerCase().match(/[a-zа-яіїєґ]{4,}/gi) || []) {
        if (!STOP.has(word)) bucket[word] = (bucket[word] || 0) + 1;
      }
      const e = r.entities || {};
      for (const mn of (e.master_names || [])) byMaster[mn] = (byMaster[mn] || 0) + (r.sentiment === 'negative' ? -1 : r.sentiment === 'positive' ? 1 : 0);
    }
    const topAspects = (sign) => Object.values(aspectStat)
      .map((a) => ({ aspect: a.aspect, score: a.positive - a.negative, ...a }))
      .filter((a) => sign > 0 ? a.score > 0 : a.score < 0)
      .sort((a, b) => sign > 0 ? b.score - a.score : a.score - b.score).slice(0, 5);
    const cloud = (obj) => Object.entries(obj).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 25);

    const d = dist || {};
    res.json({
      ok: true,
      total_reviews: d.total || 0,
      avg_sentiment_score: d.avg_s != null ? +d.avg_s : null,
      sentiment_distribution: { positive: d.pos || 0, neutral: d.neu || 0, negative: d.neg || 0 },
      top_positive_aspects: topAspects(1),
      top_negative_aspects: topAspects(-1),
      by_source: bySource.map((s) => ({ source_type: s.source_type, count: s.cnt, avg_sentiment: s.avg_s != null ? +s.avg_s : null })),
      by_master: Object.entries(byMaster).map(([name, net]) => ({ name, net_sentiment: net })).sort((a, b) => b.net_sentiment - a.net_sentiment),
      trend_weekly: weekly.map((wk) => ({ week: wk.wk, count: wk.cnt, avg_sentiment: wk.avg_s != null ? +wk.avg_s : null })),
      keyword_cloud: { positive: cloud(posWords), negative: cloud(negWords) },
    });
  } catch (e) { ERR(res, e, 'reviews_analytics'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /predictions — churn / burnout / service_decline (live-евристика)
// ?branch_id=&type=churn|burnout|service_decline&min_risk=0.5
// ════════════════════════════════════════════════════════════════════════════
router.get('/predictions', PERM_READ, async (req, res) => {
  try {
    const minRisk = Math.max(0, Math.min(1, num(req.query.min_risk) ?? 0.5));
    const want = req.query.type;
    const predictions = [];

    // ── CHURN: клієнти, де інтервал між візитами зріс + знизились оцінки/чек ──
    if (!want || want === 'churn') {
      const churn = await q(`
        WITH cv AS (
          SELECT c.id, c.name, c.total_spent,
                 COUNT(a.id)::int visits,
                 MIN(a.starts_at) first_v, MAX(a.starts_at) last_v
            FROM clients c JOIN appointments a ON a.client_id=c.id
           WHERE a.status NOT IN ${LOST} AND a.starts_at <= NOW()
           GROUP BY c.id, c.name, c.total_spent HAVING COUNT(a.id) >= 3)
        SELECT *,
               (EXTRACT(EPOCH FROM (last_v-first_v))/86400.0/NULLIF(visits-1,0)) avg_interval,
               (CURRENT_DATE - last_v::date)::int days_since
          FROM cv`).catch(() => []);
      for (const c of churn) {
        const avgInt = Number(c.avg_interval) || 0;
        if (avgInt <= 0) continue;
        const ratio = c.days_since / avgInt;
        if (ratio < 1.2 || ratio > 5) continue; // рання діагностика, ще не безнадійно
        const risk = Math.max(0, Math.min(1, (ratio - 1) / 2.5));
        if (risk < minRisk) continue;
        const signals = [`Інтервал перевищено в ${ratio.toFixed(1)}× (${c.days_since} дн. при нормі ~${Math.round(avgInt)})`];
        predictions.push({
          entity_type: 'client', entity_id: c.id, entity_name: c.name,
          risk_type: 'churn', risk_score: round(risk, 2),
          ltv: Math.round(Number(c.total_spent) || 0), visits: c.visits,
          signals,
          recommended_actions: ['Подзвонити клієнту', 'Запропонувати персональну акцію', 'Запросити на улюблену процедуру'],
        });
      }
    }

    // ── BURNOUT: майстер з низьким score + ростом скарг ──
    if (!want || want === 'burnout') {
      const weights = await getWeights(null);
      const masters = await masterLiveMetrics(60);
      for (const m of masters) {
        if (m.done < 10) continue;
        const sc = scoreMaster(m, weights);
        const complaintPressure = m.neg_reviews >= 2 ? Math.min(1, m.neg_reviews / 5) : 0;
        const lowScore = sc.overall_score < 60 ? (60 - sc.overall_score) / 60 : 0;
        const risk = Math.max(0, Math.min(1, 0.6 * lowScore + 0.4 * complaintPressure));
        if (risk < minRisk) continue;
        const signals = [];
        if (sc.overall_score < 60) signals.push(`Quality Score ${sc.overall_score} нижче норми`);
        if (m.neg_reviews >= 2) signals.push(`${m.neg_reviews} негативних відгуки за період`);
        if (sc.extra.cancel_pct > 25) signals.push(`Високий % відмін/неявок: ${sc.extra.cancel_pct}%`);
        predictions.push({
          entity_type: 'master', entity_id: m.id, entity_name: m.name,
          risk_type: 'burnout', risk_score: round(risk, 2),
          score: sc.overall_score,
          signals,
          recommended_actions: ['Провести 1:1 з майстром', 'Переглянути навантаження/розклад', 'Розглянути додатковий вихідний'],
        });
      }
    }

    // ── SERVICE_DECLINE: послуга з падінням середньої оцінки ──
    if (!want || want === 'service_decline') {
      const svc = await q(`
        WITH recent AS (
          SELECT a.service_id, AVG(r.rating)::numeric rating_now, COUNT(r.id)::int n
            FROM appointments a JOIN reviews r ON r.client_id=a.client_id
           WHERE r.created_at >= NOW() - INTERVAL '30 days' AND a.service_id IS NOT NULL
           GROUP BY a.service_id),
          older AS (
          SELECT a.service_id, AVG(r.rating)::numeric rating_old
            FROM appointments a JOIN reviews r ON r.client_id=a.client_id
           WHERE r.created_at < NOW() - INTERVAL '30 days'
             AND r.created_at >= NOW() - INTERVAL '120 days' AND a.service_id IS NOT NULL
           GROUP BY a.service_id)
        SELECT s.id, s.name, rc.rating_now, ro.rating_old, rc.n
          FROM recent rc JOIN older ro ON ro.service_id=rc.service_id
          JOIN services s ON s.id=rc.service_id
         WHERE rc.n >= 3 AND rc.rating_now < ro.rating_old`).catch(() => []);
      for (const s of svc) {
        const drop = Number(s.rating_old) - Number(s.rating_now);
        const risk = Math.max(0, Math.min(1, drop / 2));
        if (risk < minRisk) continue;
        predictions.push({
          entity_type: 'service', entity_id: s.id, entity_name: s.name,
          risk_type: 'service_decline', risk_score: round(risk, 2),
          signals: [`Середня оцінка впала з ${round(s.rating_old, 1)} до ${round(s.rating_now, 1)}`],
          recommended_actions: ['Перевірити технологію/матеріали', 'Провести аудит виконання послуги'],
        });
      }
    }

    predictions.sort((a, b) => b.risk_score - a.risk_score);
    res.json({ ok: true, count: predictions.length, predictions });
  } catch (e) { ERR(res, e, 'predictions'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /comparison — порівняння філіалів
// ?branch_ids=1,2,3&period=30d   (single-salon: якщо філіалів немає — повертаємо салон)
// ════════════════════════════════════════════════════════════════════════════
router.get('/comparison', PERM_READ, async (req, res) => {
  try {
    const days = periodDays(req.query.period);
    const ids = (req.query.branch_ids || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    const targets = ids.length ? ids : [null]; // null = весь салон
    const branches = [];
    for (const bid of targets) {
      const bm = await branchLiveMetrics(days, bid);
      const masters = await masterLiveMetrics(Math.max(days, 90));
      const weights = await getWeights(bid);
      const scored = masters.filter((m) => m.done >= 5).map((m) => scoreMaster(m, weights).overall_score);
      const score = scored.length ? round(scored.reduce((s, x) => s + x, 0) / scored.length, 1) : null;
      let name = bid ? `Філіал #${bid}` : 'Салон';
      if (bid) { const b = await one(`SELECT name FROM branches WHERE id=$1`, [bid]).catch(() => null); if (b) name = b.name; }
      branches.push({
        branch_id: bid, branch_name: name, score,
        nps: bm.nps, csat: bm.csat, wait_time: null,
        no_show_rate: bm.no_show_rate, repeat_visit_rate: bm.repeat_visit_rate,
      });
    }
    const ranked = branches.filter((b) => b.score != null).sort((a, b) => b.score - a.score);
    const best = ranked[0] || null; const worst = ranked.length ? ranked[ranked.length - 1] : null;
    const areas = [];
    if (worst && best && worst.branch_id !== best.branch_id) {
      if (worst.no_show_rate > best.no_show_rate) areas.push(`${worst.branch_name}: вищий no-show (${worst.no_show_rate}%)`);
      if ((worst.csat || 99) < (best.csat || 0)) areas.push(`${worst.branch_name}: нижчий CSAT (${worst.csat})`);
    }
    res.json({ ok: true, branches, best_branch_id: best ? best.branch_id : null, worst_branch_id: worst ? worst.branch_id : null, areas_for_improvement: areas });
  } catch (e) { ERR(res, e, 'comparison'); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET/PUT /weights — кастомні ваги Master Score (спека §10.03 weight customization)
// ════════════════════════════════════════════════════════════════════════════
router.get('/weights', PERM_READ, async (req, res) => {
  try {
    const branchId = num(req.query.branch_id);
    const weights = await getWeights(branchId);
    res.json({ ok: true, branch_id: branchId, weights, defaults: DEFAULT_WEIGHTS });
  } catch (e) { ERR(res, e, 'weights_get'); }
});

router.put('/weights', PERM_CONFIG, async (req, res) => {
  try {
    const b = req.body || {};
    const branchId = b.branch_id || null;
    const incoming = b.weights || {};
    const merged = { ...DEFAULT_WEIGHTS };
    for (const k of Object.keys(DEFAULT_WEIGHTS)) if (k in incoming) merged[k] = Number(incoming[k]) || 0;
    const uid = req.user ? req.user.id : null;
    const row = await one(
      `INSERT INTO ai_quality_score_weights (branch_id, weights, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (tenant_id, COALESCE(branch_id, 0))
       DO UPDATE SET weights=EXCLUDED.weights, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING branch_id, weights`,
      [branchId, JSON.stringify(merged), uid]);
    logAction({ user: req.user, action: 'ai_quality.weights.update', entity: 'ai_quality_score_weights', meta: { branch_id: branchId } }).catch(() => {});
    res.json({ ok: true, branch_id: row.branch_id, weights: row.weights });
  } catch (e) { ERR(res, e, 'weights_put'); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /recompute — матеріалізувати щоденні snapshot'и Master/Branch у ai_quality_scores
// (спека §10.03: score recalculation щодня 06:00 / real-time). Тут — ручний/cron-тригер.
// Body: { branch_id?, date? }
// ════════════════════════════════════════════════════════════════════════════
router.post('/recompute', PERM_RULES, async (req, res) => {
  try {
    const b = req.body || {};
    const branchId = b.branch_id || null;
    const day = b.date || null; // YYYY-MM-DD; default CURRENT_DATE
    const weights = await getWeights(branchId);
    const masters = await masterLiveMetrics(90);
    let written = 0;
    const scores = [];
    for (const m of masters) {
      if (m.done < 3) continue;
      const sc = scoreMaster(m, weights);
      scores.push(sc.overall_score);
      // benchmark_own = середній за 90 днів snapshot'ів
      await q(
        `INSERT INTO ai_quality_scores
           (branch_id, entity_type, entity_id, score_date, overall_score, components, trend, trend_delta, benchmark_own)
         VALUES ($1,'master',$2,COALESCE($3::date,CURRENT_DATE),$4,$5::jsonb,
                 COALESCE((SELECT CASE
                     WHEN $4 - prev > 3 THEN 'improving'
                     WHEN $4 - prev < -8 THEN 'critical_decline'
                     WHEN $4 - prev < -3 THEN 'declining'
                     ELSE 'stable' END
                   FROM (SELECT overall_score prev FROM ai_quality_scores
                          WHERE tenant_id=current_tenant_id() AND entity_type='master' AND entity_id=$2
                            AND score_date < COALESCE($3::date,CURRENT_DATE)
                          ORDER BY score_date DESC LIMIT 1) p), 'stable'),
                 (SELECT $4 - overall_score FROM ai_quality_scores
                   WHERE tenant_id=current_tenant_id() AND entity_type='master' AND entity_id=$2
                     AND score_date < COALESCE($3::date,CURRENT_DATE)
                   ORDER BY score_date DESC LIMIT 1),
                 (SELECT ROUND(AVG(overall_score)::numeric,2) FROM ai_quality_scores
                   WHERE tenant_id=current_tenant_id() AND entity_type='master' AND entity_id=$2
                     AND score_date >= CURRENT_DATE - INTERVAL '90 days'))
         ON CONFLICT (tenant_id, entity_type, entity_id, score_date)
         DO UPDATE SET overall_score=EXCLUDED.overall_score, components=EXCLUDED.components,
                       trend=EXCLUDED.trend, trend_delta=EXCLUDED.trend_delta, benchmark_own=EXCLUDED.benchmark_own`,
        [branchId, String(m.id), day, sc.overall_score, JSON.stringify(sc.components)]).catch((e) => { console.warn('[ai-quality:recompute:master]', e.message); });
      written++;
    }
    // branch snapshot = середній master score
    if (scores.length) {
      const branchScore = round(scores.reduce((s, x) => s + x, 0) / scores.length, 2);
      const bm = await branchLiveMetrics(30, branchId);
      await q(
        `INSERT INTO ai_quality_scores
           (branch_id, entity_type, entity_id, score_date, overall_score, components)
         VALUES ($1,'branch',$2,COALESCE($3::date,CURRENT_DATE),$4,$5::jsonb)
         ON CONFLICT (tenant_id, entity_type, entity_id, score_date)
         DO UPDATE SET overall_score=EXCLUDED.overall_score, components=EXCLUDED.components`,
        [branchId, String(branchId || 0), day, branchScore,
         JSON.stringify({ avg_master_score: branchScore, nps: bm.nps, csat: bm.csat, no_show_rate: bm.no_show_rate, repeat_visit_rate: bm.repeat_visit_rate })]).catch(() => {});
    }
    logAction({ user: req.user, action: 'ai_quality.recompute', meta: { written } }).catch(() => {});
    res.json({ ok: true, masters_scored: written, branch_score: scores.length ? round(scores.reduce((s, x) => s + x, 0) / scores.length, 2) : null });
  } catch (e) { ERR(res, e, 'recompute'); }
});

module.exports = router;
