/* ═══════════════════════════════════════════════════════
   AI-07 — AI Recommendations (персональні рекомендації)
   Подключается как /api/ai/recommendations

   Прагматична single-salon версія БЕЗ важкого ML. Евристичний гібрид
   на РЕАЛЬНИХ даних appointments/services/clients:
   - item-based CF: co-occurrence послуг (хто робив X, також робив Y);
   - content-based: збіг категорій послуги з історією клієнта;
   - популярність: fallback для cold start / анонімів;
   - гібрид: score = cf*w_cf + cb*w_cb (ваги з активної моделі);
   - exploration: домішок непопулярних items проти filter bubble.
   Лог рекомендацій + feedback (impression/click/book/...) + аналітика.

   Права: ai.read (GET) / ai.write (зміни). Owner '*' матчить усе.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

async function activeModel() {
  const m = (await q(`SELECT * FROM ai_recommendation_models WHERE is_active=true ORDER BY updated_at DESC LIMIT 1`))[0];
  return m || { id: null, hyperparameters: { w_cf: 0.6, w_cb: 0.4, exploration: 0.1 } };
}

// Топ послуг за кількістю виконаних візитів за період (днів)
async function popularServices(days, limit) {
  return q(
    `SELECT s.id, s.name, s.category, s.price, COUNT(*)::int AS bookings
       FROM appointments a JOIN services s ON s.id=a.service_id
      WHERE a.service_id IS NOT NULL AND a.status IN ('done','confirmed','booked')
        AND a.starts_at >= now() - ($1||' days')::interval
      GROUP BY s.id, s.name, s.category, s.price
      ORDER BY bookings DESC LIMIT $2`, [days, limit]);
}

// Item-based CF: послуги, які часто беруть разом із заданою (co-occurrence по клієнтах)
async function coOccurring(serviceId, limit) {
  return q(
    `WITH clients_of AS (
        SELECT DISTINCT client_id FROM appointments
         WHERE service_id=$1 AND status='done' AND client_id IS NOT NULL)
     SELECT s.id, s.name, s.category, s.price, COUNT(DISTINCT a.client_id)::int AS shared
       FROM appointments a JOIN services s ON s.id=a.service_id
      WHERE a.client_id IN (SELECT client_id FROM clients_of)
        AND a.service_id <> $1 AND a.status='done'
      GROUP BY s.id, s.name, s.category, s.price
      ORDER BY shared DESC LIMIT $2`, [serviceId, limit]);
}

/* ── авторизація ── */
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'ai.read' : 'ai.write';
  return requirePerm(perm)(req, res, next);
});

/* ── GET /popular — популярні послуги (cold start / аноніми) ── */
router.get('/popular', async (req, res) => {
  try {
    const days = req.query.period === '30d' ? 30 : (req.query.period === '90d' ? 90 : 7);
    const limit = Math.min(+req.query.limit || 10, 50);
    const items = await popularServices(days, limit);
    const max = items.length ? items[0].bookings : 1;
    res.json({ items: items.map(i => ({ item_id: i.id, item_name: i.name, category: i.category, price: Number(i.price), popularity_score: Math.round((i.bookings / max) * 100) / 100, bookings_count: i.bookings })) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /similar/:item_type/:item_id — схожі items (item-to-item) ── */
router.get('/similar/:item_type/:item_id(\\d+)', async (req, res) => {
  try {
    const limit = Math.min(+req.query.limit || 5, 20);
    if (req.params.item_type !== 'service')
      return res.json({ similar: [] });   // co-occurrence будуємо лише для послуг
    const base = (await q(`SELECT category FROM services WHERE id=$1`, [req.params.item_id]))[0];
    const rows = await coOccurring(req.params.item_id, limit);
    const max = rows.length ? rows[0].shared : 1;
    res.json({
      similar: rows.map(r => ({
        item_id: r.id, item_name: r.name, category: r.category, price: Number(r.price),
        score: Math.round((r.shared / max) * 1000) / 1000,
        shared_attributes: base && r.category === base.category ? ['category'] : []
      }))
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /models — список моделей ── */
router.get('/models', async (req, res) => {
  try {
    const models = await q(`SELECT id, name, type, algorithm, status, is_active, ab_weight, metrics, trained_at FROM ai_recommendation_models ORDER BY is_active DESC, updated_at DESC`);
    res.json({ models });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /models — створити модель ── */
router.post('/models', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    const row = (await q(
      `INSERT INTO ai_recommendation_models (name, type, algorithm, hyperparameters, status)
       VALUES ($1, COALESCE($2,'hybrid'), COALESCE($3,'cooccurrence_cosine'), COALESCE($4,'{}')::jsonb, 'ready') RETURNING *`,
      [b.name, b.type, b.algorithm, b.hyperparameters ? JSON.stringify(b.hyperparameters) : null]))[0];
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /models/:id/train — «навчити» (евристична: перерахунок метрик з feedback) ── */
router.post('/models/:id(\\d+)/train', async (req, res) => {
  try {
    const m = (await q(`SELECT * FROM ai_recommendation_models WHERE id=$1`, [req.params.id]))[0];
    if (!m) return res.status(404).json({ error: 'not_found' });
    const t0 = Date.now();
    const stats = (await q(
      `SELECT
         COUNT(*) FILTER (WHERE feedback_type='impression')::int AS impressions,
         COUNT(*) FILTER (WHERE feedback_type='click')::int AS clicks,
         COUNT(*) FILTER (WHERE feedback_type IN ('book','purchase'))::int AS conversions
       FROM ai_recommendation_feedback fb
       JOIN ai_recommendations r ON r.id=fb.recommendation_id
       WHERE r.model_id=$1`, [req.params.id]))[0];
    const dataSize = (await q(`SELECT COUNT(*)::int AS c FROM appointments WHERE status='done'`))[0].c;
    const ctr = stats.impressions > 0 ? Math.round((stats.clicks / stats.impressions) * 1000) / 1000 : 0;
    const conv = stats.impressions > 0 ? Math.round((stats.conversions / stats.impressions) * 1000) / 1000 : 0;
    const metrics = { ctr, conversion: conv, impressions: stats.impressions, clicks: stats.clicks, conversions: stats.conversions };
    const row = (await q(
      `UPDATE ai_recommendation_models SET status='ready', metrics=$2::jsonb, training_data_size=$3,
              training_duration_s=$4, trained_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, JSON.stringify(metrics), dataSize, Math.round((Date.now() - t0) / 1000)]))[0];
    res.json({ model_id: row.id, status: row.status, metrics, training_data_size: dataSize });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /models/:id/activate — зробити production ── */
router.post('/models/:id(\\d+)/activate', async (req, res) => {
  try {
    const prev = (await q(`SELECT id FROM ai_recommendation_models WHERE is_active=true`))[0];
    const row = (await q(`UPDATE ai_recommendation_models SET is_active=true, status='active', ab_weight=1.0, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await q(`UPDATE ai_recommendation_models SET is_active=false, ab_weight=0, status='ready', updated_at=now() WHERE id<>$1 AND is_active=true`, [req.params.id]);
    res.json({ model_id: row.id, is_active: true, previous_active_id: prev ? prev.id : null });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /ab/start — A/B тест (ваги трафіку між моделями) ── */
router.post('/ab/start', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.model_a_id || !b.model_b_id) return res.status(400).json({ error: 'model_a_id_and_model_b_id_required' });
    const split = Math.max(0, Math.min(1, Number(b.traffic_split) || 0.5));
    await q(`UPDATE ai_recommendation_models SET is_active=false, ab_weight=0, updated_at=now()`);
    await q(`UPDATE ai_recommendation_models SET is_active=true, status='active', ab_weight=$2, updated_at=now() WHERE id=$1`, [b.model_a_id, 1 - split]);
    await q(`UPDATE ai_recommendation_models SET is_active=true, status='active', ab_weight=$2, updated_at=now() WHERE id=$1`, [b.model_b_id, split]);
    const days = Number(b.duration_days) || 14;
    res.json({ test_id: `${b.model_a_id}_vs_${b.model_b_id}`, started_at: new Date().toISOString(), estimated_end_at: new Date(Date.now() + days * 864e5).toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /ab/results — результати A/B (конверсія по моделях) ── */
router.get('/ab/results', async (req, res) => {
  try {
    const rows = await q(
      `SELECT r.model_id, m.name,
              COUNT(*) FILTER (WHERE fb.feedback_type='impression')::int AS impressions,
              COUNT(*) FILTER (WHERE fb.feedback_type='click')::int AS clicks,
              COUNT(*) FILTER (WHERE fb.feedback_type IN ('book','purchase'))::int AS conversions,
              COALESCE(SUM(r.conversion_revenue),0)::numeric AS revenue
         FROM ai_recommendations r
         JOIN ai_recommendation_models m ON m.id=r.model_id
         LEFT JOIN ai_recommendation_feedback fb ON fb.recommendation_id=r.id
        WHERE m.ab_weight>0
        GROUP BY r.model_id, m.name ORDER BY r.model_id`);
    const fmt = x => ({
      model_id: x.model_id, name: x.name, sample_size: x.impressions,
      ctr: x.impressions > 0 ? Math.round((x.clicks / x.impressions) * 1000) / 1000 : 0,
      conversion: x.impressions > 0 ? Math.round((x.conversions / x.impressions) * 1000) / 1000 : 0,
      revenue: Number(x.revenue)
    });
    const a = rows[0] ? fmt(rows[0]) : null, bb = rows[1] ? fmt(rows[1]) : null;
    let winner = null, significant = false;
    if (a && bb) {
      winner = a.conversion >= bb.conversion ? a.model_id : bb.model_id;
      significant = (a.sample_size + bb.sample_size) >= 200 && Math.abs(a.conversion - bb.conversion) > 0.02;
    }
    res.json({ model_a: a, model_b: bb, winner, is_significant: significant });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /analytics — аналітика рекомендацій ── */
router.get('/analytics', async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.from) { params.push(req.query.from); wh.push(`r.created_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); wh.push(`r.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (req.query.model_id) { params.push(req.query.model_id); wh.push(`r.model_id=$${params.length}`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const agg = (await q(
      `SELECT
         COUNT(*) FILTER (WHERE fb.feedback_type='impression')::int AS impressions,
         COUNT(*) FILTER (WHERE fb.feedback_type='click')::int AS clicks,
         COUNT(*) FILTER (WHERE fb.feedback_type IN ('book','purchase'))::int AS conversions,
         COALESCE(SUM(r.conversion_revenue),0)::numeric AS revenue,
         COUNT(DISTINCT r.item_id)::int AS distinct_items
       FROM ai_recommendations r LEFT JOIN ai_recommendation_feedback fb ON fb.recommendation_id=r.id ${where}`, params))[0];
    const totalServices = (await q(`SELECT COUNT(*)::int AS c FROM services WHERE active=true`))[0].c;
    const topItems = await q(
      `SELECT r.item_type, r.item_id, COUNT(*)::int AS shown,
              COUNT(*) FILTER (WHERE r.status='converted')::int AS converted
         FROM ai_recommendations r ${where}
         GROUP BY r.item_type, r.item_id ORDER BY shown DESC LIMIT 10`, params);
    const byContext = await q(
      `SELECT r.context, COUNT(*)::int AS cnt FROM ai_recommendations r ${where} GROUP BY r.context ORDER BY cnt DESC`, params);
    res.json({
      total_impressions: agg.impressions, total_clicks: agg.clicks,
      ctr: agg.impressions > 0 ? Math.round((agg.clicks / agg.impressions) * 1000) / 1000 : 0,
      conversion_rate: agg.impressions > 0 ? Math.round((agg.conversions / agg.impressions) * 1000) / 1000 : 0,
      incremental_revenue: Number(agg.revenue),
      coverage: totalServices > 0 ? Math.round((agg.distinct_items / totalServices) * 100) / 100 : 0,
      top_recommended_items: topItems, by_context: byContext
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /features/:entity_type/:entity_id — фічі (live-розрахунок) ── */
router.get('/features/:entity_type/:entity_id(\\d+)', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.params;
    let features = {};
    if (entity_type === 'client') {
      const c = (await q(
        `SELECT COUNT(*) FILTER (WHERE status='done')::int AS total_visits,
                COALESCE(AVG(price) FILTER (WHERE status='done'),0)::numeric AS avg_check,
                MAX(starts_at) AS last_visit
           FROM appointments WHERE client_id=$1`, [entity_id]))[0];
      const cats = await q(
        `SELECT s.category, COUNT(*)::int AS c FROM appointments a JOIN services s ON s.id=a.service_id
          WHERE a.client_id=$1 AND a.status='done' AND s.category IS NOT NULL
          GROUP BY s.category ORDER BY c DESC LIMIT 3`, [entity_id]);
      features = {
        total_visits: c.total_visits, avg_check: Math.round(Number(c.avg_check)),
        preferred_categories: cats.map(x => x.category),
        days_since_last: c.last_visit ? Math.floor((Date.now() - new Date(c.last_visit).getTime()) / 864e5) : null
      };
    } else if (entity_type === 'service') {
      const s = (await q(
        `SELECT
           COUNT(*) FILTER (WHERE starts_at >= now()-INTERVAL '7 days')::int AS popularity_7d,
           COUNT(*) FILTER (WHERE starts_at >= now()-INTERVAL '30 days')::int AS popularity_30d
         FROM appointments WHERE service_id=$1 AND status='done'`, [entity_id]))[0];
      features = s;
    } else if (entity_type === 'master') {
      const m = (await q(
        `SELECT COUNT(*) FILTER (WHERE starts_at >= now()-INTERVAL '7 days')::int AS load_7d
           FROM appointments WHERE master_id=$1 AND status IN ('done','confirmed','booked')`, [entity_id]))[0];
      features = m;
    }
    // кешуємо у feature store
    await q(
      `INSERT INTO ai_feature_store (entity_type, entity_id, features, computed_at, valid_until)
       VALUES ($1,$2,$3::jsonb, now(), now()+INTERVAL '24 hours')
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET features=EXCLUDED.features, computed_at=now(), valid_until=EXCLUDED.valid_until`,
      [entity_type, entity_id, JSON.stringify(features)]);
    res.json({ entity_type, entity_id: Number(entity_id), features, computed_at: new Date().toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /feedback — зафіксувати feedback ── */
router.post('/feedback', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.recommendation_id || !b.feedback_type)
      return res.status(400).json({ error: 'recommendation_id_and_feedback_type_required' });
    const rec = (await q(`SELECT id, client_id FROM ai_recommendations WHERE id=$1`, [b.recommendation_id]))[0];
    if (!rec) return res.status(404).json({ error: 'recommendation_not_found' });
    await q(
      `INSERT INTO ai_recommendation_feedback (recommendation_id, client_id, feedback_type, context_data)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [b.recommendation_id, rec.client_id, b.feedback_type, JSON.stringify(b.context_data || {})]);
    // оновлюємо статус рекомендації за типом сигналу
    const map = { impression: ['shown', 'shown_at'], click: ['clicked', 'clicked_at'], book: ['converted', 'converted_at'], purchase: ['converted', 'converted_at'], dismiss: ['dismissed', null] };
    const upd = map[b.feedback_type];
    if (upd) {
      const tsCol = upd[1] ? `, ${upd[1]}=now()` : '';
      const rev = (b.feedback_type === 'book' || b.feedback_type === 'purchase') && b.context_data?.revenue ? `, conversion_revenue=${Number(b.context_data.revenue) || 0}` : '';
      await q(`UPDATE ai_recommendations SET status=$2${tsCol}${rev} WHERE id=$1`, [b.recommendation_id, upd[0]]);
    }
    res.json({ received: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /:client_id — персональні рекомендації клієнта ──
   (останнім, щоб не перехоплювати літеральні шляхи вище) */
router.get('/:client_id(\\d+)', async (req, res) => {
  try {
    const clientId = req.params.client_id;
    const type = req.query.type || 'service';
    const context = req.query.context || 'catalog';
    const limit = Math.min(+req.query.limit || 10, 30);
    const model = await activeModel();
    const hp = model.hyperparameters || {};
    const wCf = hp.w_cf ?? 0.6, wCb = hp.w_cb ?? 0.4, expl = hp.exploration ?? 0.1;

    if (type === 'master') {
      // сумісність майстер-клієнт: повторні візити + рейтинг майстра
      const rows = await q(
        `SELECT m.id, m.name, m.avatar, COUNT(*)::int AS visits
           FROM appointments a JOIN masters m ON m.id=a.master_id
          WHERE a.client_id=$1 AND a.status='done' AND m.active=true
          GROUP BY m.id, m.name, m.avatar ORDER BY visits DESC LIMIT $2`, [clientId, limit]);
      const max = rows.length ? rows[0].visits : 1;
      const recs = rows.map((r, i) => ({
        item_type: 'master', item_id: r.id, item_name: r.name, item_image: r.avatar,
        score: Math.round((r.visits / max) * 1000) / 1000, reason: 'repeat', rank: i + 1,
        explanation: `Ви вже відвідували майстра ${r.name} — він знає ваші вподобання`
      }));
      return res.json({ recommendations: recs, model_id: model.id, generated_at: new Date().toISOString() });
    }

    // type=service (основний): гібрид CF (co-occurrence) + CB (категорії) + популярність
    const history = await q(
      `SELECT DISTINCT s.id, s.category FROM appointments a JOIN services s ON s.id=a.service_id
        WHERE a.client_id=$1 AND a.status='done'`, [clientId]);
    const doneIds = new Set(history.map(h => h.id));
    const catCount = {};
    for (const h of history) if (h.category) catCount[h.category] = (catCount[h.category] || 0) + 1;
    const topCats = Object.keys(catCount).sort((a, b) => catCount[b] - catCount[a]);

    // CF: збираємо co-occurrence по всіх послугах історії
    const cfScore = {};
    for (const h of history) {
      const co = await coOccurring(h.id, 15);
      const max = co.length ? co[0].shared : 1;
      for (const c of co) if (!doneIds.has(c.id)) cfScore[c.id] = Math.max(cfScore[c.id] || 0, c.shared / max);
    }
    // кандидати: усі активні послуги, які клієнт ще не пробував
    const candidates = await q(`SELECT id, name, category, price FROM services WHERE active=true`);
    const scored = [];
    for (const s of candidates) {
      if (doneIds.has(s.id)) continue;
      const cf = cfScore[s.id] || 0;
      const cb = s.category && topCats.includes(s.category) ? (1 - topCats.indexOf(s.category) * 0.2) : 0;
      const score = cf * wCf + cb * wCb;
      let reason = 'popular', explanation = `Популярна послуга у нашому салоні`;
      if (cf > 0 && cf * wCf >= cb * wCb) { reason = 'similar_items'; explanation = `Клієнти, схожі на вас, також обирають «${s.name}»`; }
      else if (cb > 0) { reason = 'profile_match'; explanation = `Підходить до ваших улюблених послуг (${s.category})`; }
      scored.push({ item_type: 'service', item_id: s.id, item_name: s.name, category: s.category, price: Number(s.price), score, cf_score: cf, cb_score: cb, reason, explanation });
    }

    let ranked = scored.sort((a, b) => b.score - a.score);
    // якщо нема історії / усе по нулях → популярність як cold-start
    if (!ranked.length || ranked.every(r => r.score === 0)) {
      const pop = await popularServices(30, limit);
      const max = pop.length ? pop[0].bookings : 1;
      ranked = pop.filter(p => !doneIds.has(p.id)).map(p => ({
        item_type: 'service', item_id: p.id, item_name: p.name, category: p.category, price: Number(p.price),
        score: Math.round((p.bookings / max) * 1000) / 1000, cf_score: 0, cb_score: 0,
        reason: 'popular', explanation: `Популярна послуга — ${p.bookings} записів за місяць`
      }));
    }

    let top = ranked.slice(0, limit);
    // exploration: домішуємо випадкову непопулярну послугу
    if (expl > 0 && ranked.length > limit && Math.random() < expl) {
      const tail = ranked.slice(limit);
      const pick = tail[Math.floor(Math.random() * tail.length)];
      pick.reason = 'exploration'; pick.explanation = 'Спробуйте щось нове';
      top[top.length - 1] = pick;
    }

    // лог рекомендацій
    const out = [];
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      const row = (await q(
        `INSERT INTO ai_recommendations (client_id, item_type, item_id, model_id, score, cf_score, cb_score, rank, reason, explanation, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [clientId, t.item_type, t.item_id, model.id, Math.min(t.score, 9.9999), t.cf_score ?? null, t.cb_score ?? null, i + 1, t.reason, t.explanation, context]))[0];
      out.push({ id: row.id, item_type: t.item_type, item_id: t.item_id, item_name: t.item_name, category: t.category, price: t.price, score: Math.round(t.score * 1000) / 1000, reason: t.reason, explanation: t.explanation, rank: i + 1 });
    }
    res.json({ recommendations: out, model_id: model.id, generated_at: new Date().toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
