/* routes/recommendations.js — AI-07 Recommendations (прагматична версія для 1 салону).
   Без важких ML (ALS/SVD/neural CF) — item-based collaborative filtering на чистому SQL:
   co-occurrence послуг (які послуги беруть одні й ті самі клієнти) + персональні
   рекомендації (послуги, яких клієнт ще не пробував, але часто беруть разом з його)
   + список на повернення (win-back клієнтів, що зникли).

   Ендпоінти:
     GET /api/recommendations/cross-sell?service_id=N  — «з цією послугою часто беруть»
     GET /api/recommendations/client/:id               — персональні рекомендації клієнту
     GET /api/recommendations/reactivation             — клієнти на повернення (win-back)
     GET /api/recommendations/pairs                     — топ пар послуг (для маркетингу)
   Доступ: reports.read. Дані рахуються на льоту з appointments. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();

// База co-occurrence: для кожної пари (s1,s2) — скільки клієнтів брали обидві.
// Окремо популярність кожної послуги (для lift).
const COOC = `
WITH cs AS (
  SELECT DISTINCT client_id, service_id
    FROM appointments
   WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW() AND service_id IS NOT NULL AND client_id IS NOT NULL
)`;

// ── GET /cross-sell?service_id=N ───────────────────────────
router.get('/cross-sell', requirePerm('reports.read'), async (req, res) => {
  try {
    const sid = parseInt(req.query.service_id, 10);
    if (!sid) return res.status(400).json({ error: 'no_service_id' });
    const rows = await pool.query(`${COOC},
      base AS (SELECT COUNT(DISTINCT client_id)::int AS n FROM cs WHERE service_id=$1)
      SELECT b.service_id, s.name, s.price,
             COUNT(DISTINCT a.client_id)::int AS together,
             (SELECT COUNT(DISTINCT client_id) FROM cs WHERE service_id=b.service_id)::int AS total_b
        FROM cs a
        JOIN cs b ON a.client_id=b.client_id AND b.service_id<>a.service_id
        LEFT JOIN services s ON s.id=b.service_id
       WHERE a.service_id=$1
       GROUP BY b.service_id, s.name, s.price
       ORDER BY together DESC LIMIT 8`, [sid]).then(r => r.rows).catch(() => []);
    const baseN = await pool.query(`${COOC} SELECT COUNT(DISTINCT client_id)::int n FROM cs WHERE service_id=$1`, [sid]).then(r => r.rows[0]?.n || 0).catch(() => 0);
    const out = rows.map(r => ({
      service_id: r.service_id,
      name: r.name || `Послуга #${r.service_id}`,
      price: r.price != null ? Math.round(Number(r.price)) : null,
      together: r.together,
      // confidence: P(беруть B | брали A)
      confidence_pct: baseN ? Math.round((r.together / baseN) * 100) : 0,
    }));
    res.json({ ok: true, service_id: sid, base_clients: baseN, recommendations: out });
  } catch (e) {
    console.error('[rec:cross-sell]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /client/:id — персональні рекомендації ─────────────
router.get('/client/:id', requirePerm('reports.read'), async (req, res) => {
  try {
    const cid = parseInt(req.params.id, 10);
    if (!cid) return res.status(400).json({ error: 'bad_id' });
    const [myServices, recs, favMaster, profile] = await Promise.all([
      pool.query(`SELECT DISTINCT service_id FROM appointments WHERE client_id=$1 AND status NOT IN ('cancelled','noshow') AND starts_at <= NOW() AND service_id IS NOT NULL`, [cid]).then(r => r.rows.map(x => x.service_id)).catch(() => []),
      // item-based CF: послуги, які беруть клієнти зі схожим набором, але клієнт ще не брав
      pool.query(`${COOC},
        my AS (SELECT DISTINCT service_id FROM appointments WHERE client_id=$1 AND status NOT IN ('cancelled','noshow') AND starts_at <= NOW() AND service_id IS NOT NULL)
        SELECT b.service_id, s.name, s.price, COUNT(DISTINCT a.client_id)::int AS score
          FROM cs a
          JOIN cs b ON a.client_id=b.client_id
          LEFT JOIN services s ON s.id=b.service_id
         WHERE a.service_id IN (SELECT service_id FROM my)
           AND b.service_id NOT IN (SELECT service_id FROM my)
           AND a.client_id<>$1
         GROUP BY b.service_id, s.name, s.price
         ORDER BY score DESC LIMIT 5`, [cid]).then(r => r.rows).catch(() => []),
      pool.query(`SELECT m.name, COUNT(*)::int AS visits
                    FROM appointments a JOIN masters m ON m.id=a.master_id
                   WHERE a.client_id=$1 AND a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW()
                   GROUP BY m.name ORDER BY visits DESC LIMIT 1`, [cid]).then(r => r.rows[0] || null).catch(() => null),
      pool.query(`SELECT name, total_spent, last_visit_at,
                         (SELECT COUNT(*) FROM appointments WHERE client_id=$1 AND status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int AS done_visits
                    FROM clients WHERE id=$1`, [cid]).then(r => r.rows[0] || null).catch(() => null),
    ]);
    const recommendations = recs.map(r => ({
      service_id: r.service_id,
      name: r.name || `Послуга #${r.service_id}`,
      price: r.price != null ? Math.round(Number(r.price)) : null,
      reason: 'Часто беруть клієнти зі схожими послугами',
      score: r.score,
    }));
    // популярний fallback для нових клієнтів (мало історії)
    let fallback = [];
    if (recommendations.length < 3) {
      fallback = await pool.query(`SELECT a.service_id, s.name, s.price, COUNT(*)::int AS cnt
          FROM appointments a LEFT JOIN services s ON s.id=a.service_id
         WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW() AND a.service_id IS NOT NULL
           ${myServices.length ? 'AND a.service_id <> ALL($1)' : ''}
         GROUP BY a.service_id, s.name, s.price ORDER BY cnt DESC LIMIT ${5 - recommendations.length}`,
        myServices.length ? [myServices] : []).then(r => r.rows.map(x => ({
          service_id: x.service_id, name: x.name || `Послуга #${x.service_id}`,
          price: x.price != null ? Math.round(Number(x.price)) : null,
          reason: 'Популярна в салоні', score: x.cnt,
        }))).catch(() => []);
    }
    res.json({
      ok: true, client_id: cid,
      profile: profile ? { name: profile.name, total_spent: Math.round(Number(profile.total_spent || 0)), last_visit: profile.last_visit_at, done_visits: profile.done_visits } : null,
      favorite_master: favMaster ? { name: favMaster.name, visits: favMaster.visits } : null,
      recommendations: [...recommendations, ...fallback],
    });
  } catch (e) {
    console.error('[rec:client]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /reactivation — список на повернення ───────────────
router.get('/reactivation', requirePerm('reports.read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 30), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    // «Останній візит» = максимум з ДВОХ джерел:
    //   1) last_visit_at — заморожений знімок вигрузки MyClients (24.05.2026);
    //   2) жива синхронізація appointments (status не cancelled/noshow, включно з майбутніми записами).
    // Знімок 24.05 застарілий: клієнт міг повернутися ПІСЛЯ нього → у списку на повернення
    // його бути НЕ повинно. Тому фільтр і days_since рахуємо від eff_last (реальний останній контакт).
    const rows = await pool.query(
      `SELECT * FROM (
         SELECT c.id, c.name, c.phone, c.total_spent,
                GREATEST(c.last_visit_at::date, COALESCE(lv.live_last, c.last_visit_at::date)) AS last_visit,
                c.last_visit_at::date AS snapshot_visit,
                lv.live_last,
                c.total_visits::int AS visits,
                (CURRENT_DATE - GREATEST(c.last_visit_at::date, COALESCE(lv.live_last, c.last_visit_at::date)))::int AS days_since,
                (SELECT m.name FROM appointments a2 JOIN masters m ON m.id=a2.master_id
                  WHERE a2.client_id=c.id AND a2.status NOT IN ('cancelled','noshow') AND a2.starts_at <= NOW() ORDER BY a2.starts_at DESC LIMIT 1) AS last_master,
                (SELECT COALESCE(NULLIF(a3.services_text,''), s.name)
                   FROM appointments a3 LEFT JOIN services s ON s.id=a3.service_id
                  WHERE a3.client_id=c.id AND a3.status NOT IN ('cancelled','noshow') AND a3.starts_at <= NOW() ORDER BY a3.starts_at DESC LIMIT 1) AS last_service
           FROM clients c
           LEFT JOIN LATERAL (
             SELECT MAX(a.starts_at)::date AS live_last
               FROM appointments a
              WHERE a.client_id = c.id
                AND a.status NOT IN ('cancelled','noshow')
           ) lv ON TRUE
          WHERE c.last_visit_at IS NOT NULL
            AND COALESCE(c.total_visits,0) >= 2
       ) t
       WHERE t.last_visit < CURRENT_DATE - ($1)::int
       ORDER BY t.total_spent DESC NULLS LAST, t.days_since ASC
       LIMIT $2`, [days, limit]).then(r => r.rows).catch((e) => { console.error('[rec:reactivation:q]', e.message); return []; });
    const out = rows.map(r => ({
      client_id: r.id, name: r.name, phone: r.phone,
      total_spent: Math.round(Number(r.total_spent || 0)),
      visits: r.visits, days_since: r.days_since,
      last_visit: r.last_visit, last_master: r.last_master, last_service: r.last_service,
    }));
    const totalValue = out.reduce((s, x) => s + x.total_spent, 0);
    res.json({ ok: true, threshold_days: days, count: out.length, total_value: totalValue, clients: out });
  } catch (e) {
    console.error('[rec:reactivation]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /pairs — топ пар послуг (для маркетингу/бандлів) ────
let _pairsCache = { at: 0, data: null };
router.get('/pairs', requirePerm('reports.read'), async (req, res) => {
  try {
    if (_pairsCache.data && Date.now() - _pairsCache.at < 10 * 60 * 1000) return res.json({ ..._pairsCache.data, cached: true });
    const rows = await pool.query(`${COOC}
      SELECT a.service_id s1, b.service_id s2,
             sa.name n1, sb.name n2,
             COUNT(DISTINCT a.client_id)::int AS together
        FROM cs a
        JOIN cs b ON a.client_id=b.client_id AND a.service_id < b.service_id
        LEFT JOIN services sa ON sa.id=a.service_id
        LEFT JOIN services sb ON sb.id=b.service_id
       GROUP BY a.service_id, b.service_id, sa.name, sb.name
       ORDER BY together DESC LIMIT 10`).then(r => r.rows).catch(() => []);
    const out = rows.map(r => ({
      a: r.n1 || `#${r.s1}`, b: r.n2 || `#${r.s2}`, together: r.together,
    }));
    const payload = { ok: true, pairs: out, cached: false };
    _pairsCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    console.error('[rec:pairs]', e); res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
