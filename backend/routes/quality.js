/* routes/quality.js — AI-10 Quality Control (прагматична версія для 1 салону).
   Без важкого NLP/ML — Quality Score рахується з ОБ'ЄКТИВНИХ сигналів, які вже є
   в базі: повертаність клієнтів (retention), надійність (% відмін/неявок),
   відгуки (рейтинг+sentiment, якщо є), продуктивність. Плюс ПРЕДИКТИВНЕ
   виявлення відтоку: клієнти, у яких інтервал між візитами почав зростати —
   алерт ДО того, як клієнт остаточно зник.

   Ендпоінти (доступ reports.read):
     GET /api/quality/overview        — Quality Score салону + по майстрах + алерти
     GET /api/quality/master/:id      — деталізація по майстру
     GET /api/quality/at-risk         — клієнти з ростом ризику відтоку (рання діагностика)
   Дані рахуються на льоту. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

const WINDOW_DAYS = 180;
const REVIEW_NEUTRAL = 0.8; // якщо відгуків немає — нейтральна частка замість штрафу

/** Метрики якості по майстрах за вікно. */
async function masterMetrics() {
  const rows = await pool.query(`
    WITH m_appts AS (
      SELECT a.master_id, a.client_id, a.status, a.starts_at
        FROM appointments a
       WHERE a.starts_at >= NOW() - ($1 || ' days')::interval
    ),
    per_master AS (
      SELECT master_id,
             COUNT(*) FILTER (WHERE status='done')::int AS done,
             COUNT(*) FILTER (WHERE status IN ('cancelled','noshow'))::int AS lost,
             COUNT(DISTINCT client_id) FILTER (WHERE status='done')::int AS uniq_clients
        FROM m_appts GROUP BY master_id
    ),
    returners AS (
      SELECT master_id, COUNT(*)::int AS returning_clients FROM (
        SELECT master_id, client_id
          FROM m_appts WHERE status='done' AND client_id IS NOT NULL
         GROUP BY master_id, client_id HAVING COUNT(*) >= 2
      ) t GROUP BY master_id
    ),
    reviews_m AS (
      SELECT master_id::int AS master_id, COUNT(*)::int AS reviews, AVG(rating)::numeric AS avg_rating,
             COUNT(*) FILTER (WHERE sentiment='negative')::int AS neg
        FROM reviews WHERE status NOT IN ('rejected','spam') AND master_id ~ '^[0-9]+$'
         AND created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY master_id
    )
    SELECT m.id, m.name,
           COALESCE(pm.done,0) AS done, COALESCE(pm.lost,0) AS lost,
           COALESCE(pm.uniq_clients,0) AS uniq_clients,
           COALESCE(r.returning_clients,0) AS returning_clients,
           COALESCE(rv.reviews,0) AS reviews, rv.avg_rating, COALESCE(rv.neg,0) AS neg_reviews
      FROM masters m
      LEFT JOIN per_master pm ON pm.master_id=m.id
      LEFT JOIN returners r ON r.master_id=m.id
      LEFT JOIN reviews_m rv ON rv.master_id=m.id
     WHERE m.active=true AND COALESCE(m.provides_services,true)=true
       AND COALESCE(pm.done,0) >= 10
     ORDER BY done DESC`, [WINDOW_DAYS]).then(r => r.rows).catch(() => []);

  const maxDone = Math.max(...rows.map(r => r.done), 1);
  return rows.map(r => {
    const retention = r.uniq_clients ? r.returning_clients / r.uniq_clients : 0;
    const reliability = (r.done + r.lost) ? r.done / (r.done + r.lost) : 1;
    const reviewScore = r.reviews >= 1 && r.avg_rating != null ? Number(r.avg_rating) / 5 : REVIEW_NEUTRAL;
    const productivity = r.done / maxDone;
    const score = Math.round(100 * (0.40 * retention + 0.35 * reliability + 0.15 * reviewScore + 0.10 * productivity));
    const cancelPct = (r.done + r.lost) ? Math.round((r.lost / (r.done + r.lost)) * 100) : 0;
    return {
      master_id: r.id, name: r.name,
      score,
      done: r.done, lost: r.lost,
      retention_pct: Math.round(retention * 100),
      cancel_pct: cancelPct,
      reviews: r.reviews,
      avg_rating: r.avg_rating != null ? +Number(r.avg_rating).toFixed(1) : null,
      neg_reviews: r.neg_reviews,
      grade: score >= 80 ? 'excellent' : score >= 65 ? 'good' : score >= 50 ? 'average' : 'poor',
    };
  });
}

function masterAlerts(masters) {
  const al = [];
  for (const m of masters) {
    if (m.score < 50) al.push({ level: 'critical', master: m.name, msg: `Низький Quality Score (${m.score}/100) — потрібна увага` });
    else if (m.cancel_pct > 30) al.push({ level: 'warning', master: m.name, msg: `Високий % відмін/неявок: ${m.cancel_pct}% (${m.lost} з ${m.done + m.lost})` });
    if (m.retention_pct < 30 && m.done >= 20) al.push({ level: 'warning', master: m.name, msg: `Низька повертаність клієнтів: ${m.retention_pct}% — клієнти не повертаються` });
    if (m.neg_reviews >= 2) al.push({ level: 'warning', master: m.name, msg: `${m.neg_reviews} негативних відгуки за період` });
  }
  return al;
}

// ── GET /overview ──────────────────────────────────────────
router.get('/overview', requirePerm('reports.read'), async (req, res) => {
  try {
    const masters = await masterMetrics();
    const ranked = [...masters].sort((a, b) => b.score - a.score);
    const salonScore = masters.length ? Math.round(masters.reduce((s, m) => s + m.score, 0) / masters.length) : null;
    const totalDone = masters.reduce((s, m) => s + m.done, 0);
    const totalLost = masters.reduce((s, m) => s + m.lost, 0);
    res.json({
      ok: true,
      window_days: WINDOW_DAYS,
      salon_score: salonScore,
      salon_grade: salonScore == null ? null : salonScore >= 80 ? 'excellent' : salonScore >= 65 ? 'good' : salonScore >= 50 ? 'average' : 'poor',
      cancel_pct_total: (totalDone + totalLost) ? Math.round((totalLost / (totalDone + totalLost)) * 100) : 0,
      masters: ranked,
      best: ranked[0] || null,
      worst: ranked.length ? ranked[ranked.length - 1] : null,
      alerts: masterAlerts(masters),
    });
  } catch (e) {
    console.error('[quality:overview]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /master/:id ────────────────────────────────────────
router.get('/master/:id', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const masters = await masterMetrics();
    const m = masters.find(x => x.master_id === id);
    if (!m) return res.status(404).json({ error: 'not_found', message: 'Замало даних по майстру (<10 виконаних).' });
    // останні відгуки
    const reviews = await pool.query(
      `SELECT rating, text, sentiment, created_at FROM reviews
        WHERE master_id=$1::text AND status NOT IN ('rejected','spam')
        ORDER BY created_at DESC LIMIT 5`, [id]).then(r => r.rows).catch(() => []);
    res.json({ ok: true, master: m, recent_reviews: reviews });
  } catch (e) {
    console.error('[quality:master]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /at-risk — предиктивний відтік ─────────────────────
// Клієнти з >=3 візитами, у яких час від останнього візиту почав перевищувати
// їхній звичний інтервал (рання діагностика, ДО повного відтоку).
router.get('/at-risk', requirePerm('reports.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
    const rows = await pool.query(`
      WITH cv AS (
        SELECT c.id, c.name, c.phone, c.total_spent,
               COUNT(a.id)::int AS visits,
               MIN(a.starts_at) AS first_v, MAX(a.starts_at) AS last_v
          FROM clients c JOIN appointments a ON a.client_id=c.id
         WHERE a.status='done'
         GROUP BY c.id, c.name, c.phone, c.total_spent
        HAVING COUNT(a.id) >= 3
      )
      SELECT *,
             (EXTRACT(EPOCH FROM (last_v - first_v))/86400.0 / NULLIF(visits-1,0)) AS avg_interval_days,
             (CURRENT_DATE - last_v::date)::int AS days_since
        FROM cv`).then(r => r.rows).catch(() => []);
    const scored = [];
    for (const r of rows) {
      const avgInt = Number(r.avg_interval_days) || 0;
      if (avgInt <= 0) continue;
      const ratio = r.days_since / avgInt;
      // рання діагностика: вже перевищив звичний інтервал, але ще не безнадійно (ratio<4)
      if (ratio < 1.2 || ratio > 4) continue;
      const level = ratio >= 2.2 ? 'high' : ratio >= 1.6 ? 'medium' : 'watch';
      scored.push({
        client_id: r.id, name: r.name, phone: r.phone,
        total_spent: Math.round(Number(r.total_spent || 0)),
        visits: r.visits,
        avg_interval_days: Math.round(avgInt),
        days_since: r.days_since,
        overdue_ratio: +ratio.toFixed(1),
        risk: level,
      });
    }
    scored.sort((a, b) => (b.overdue_ratio * b.total_spent) - (a.overdue_ratio * a.total_spent));
    const out = scored.slice(0, limit);
    res.json({
      ok: true,
      count: out.length,
      high: out.filter(c => c.risk === 'high').length,
      potential_value: out.reduce((s, c) => s + c.total_spent, 0),
      clients: out,
    });
  } catch (e) {
    console.error('[quality:at-risk]', e); res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
