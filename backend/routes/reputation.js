/* ═══════════════════════════════════════════════════════
   MKT-06 — Reputation Management (внутренний контур)
   Подключается как /api/reputation

   Что закрывает:
   - лента отзывов с фильтрами + детали;
   - ответы на отзывы, заметки, эскалация негатива (алерт в Telegram);
   - аналитика репутации: рейтинг, динамика, NPS, sentiment, доля негатива;
   - запрос отзыва после визита (через Notification Hub);
   - публичная двухступенчатая форма: 4-5★ → редирект на Google,
     1-3★ → приватная форма обратной связи + алерт руководителю.

   Внешний поллинг Google/Meta — отдельный модуль (нужны API-ключи/OAuth).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const hub = require('../lib/notification-hub');
const { normalizePhoneDb } = require('../lib/phone'); // канон 380... = clients.phone (міграція 200)

const TENANT = '00000000-0000-0000-0000-000000000000';

function sentimentOf(rating) {
  return rating >= 4 ? 'positive' : (rating === 3 ? 'neutral' : 'negative');
}
async function getSettings(pool) {
  const r = await pool.query(`SELECT * FROM reputation_settings WHERE tenant_id=$1`, [TENANT]);
  return r.rows[0] || { min_redirect_rating: 4, request_cooldown_days: 30, request_enabled: true, alert_low_rating: true };
}
async function alertManager(text) {
  const chat = process.env.ADMIN_TG_CHAT;
  if (!chat) return;
  try { await hub.enqueue({ recipient: chat, channel: 'telegram', body: text, category: 'transactional', priority: 'critical', source: 'reputation-alert' }); } catch (_) {}
}

// ── Лента отзывов ───────────────────────────────────────────────────
// GET /api/reputation/reviews?status=&rating_min=&rating_max=&sentiment=&source=&from=&to=&limit=&offset=
router.get('/reviews', requirePerm('reports.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { status, rating_min, rating_max, sentiment, source, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const where = [], args = [];
    if (status)     { args.push(status);              where.push(`r.status=$${args.length}`); }
    if (rating_min) { args.push(parseInt(rating_min)); where.push(`r.rating>=$${args.length}`); }
    if (rating_max) { args.push(parseInt(rating_max)); where.push(`r.rating<=$${args.length}`); }
    if (sentiment)  { args.push(sentiment);           where.push(`r.sentiment=$${args.length}`); }
    if (source)     { args.push(source);              where.push(`r.source=$${args.length}`); }
    if (from)       { args.push(from);                where.push(`r.created_at>=$${args.length}`); }
    if (to)         { args.push(to);                  where.push(`r.created_at<=$${args.length}`); }
    args.push(limit); args.push(offset);
    const r = await pool.query(
      `SELECT r.id, r.client_id, r.client_phone, r.master_id, r.master_name,
              r.service_name, r.rating, r.text, r.is_anonymous, r.status, r.sentiment,
              r.source, r.reply, r.replied_at, r.internal_note, r.escalated_at, r.created_at,
              c.name AS client_name
         FROM reviews r LEFT JOIN clients c ON c.id = r.client_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/reviews/:id', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await getPool().query(`SELECT * FROM reviews WHERE id=$1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ review: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/reputation/reviews/:id/reply  { reply }
router.post('/reviews/:id/reply', requirePerm('reviews.write'), async (req, res) => {
  try {
    const { reply } = req.body || {};
    if (!reply || !String(reply).trim()) return res.status(400).json({ error: 'reply-required' });
    const r = await getPool().query(
      `UPDATE reviews SET reply=$1, replied_at=NOW(), replied_by=$2,
              status=CASE WHEN status='pending' THEN 'published' ELSE status END
         WHERE id=$3 RETURNING *`,
      [String(reply).slice(0, 2000), req.user?.id || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, review: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/reputation/reviews/:id  { status, internal_note, sentiment }
router.patch('/reviews/:id', requirePerm('reviews.write'), async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], args = [];
    if (b.status && ['published', 'hidden', 'pending'].includes(b.status)) { args.push(b.status); sets.push(`status=$${args.length}`); }
    if ('internal_note' in b) { args.push(b.internal_note); sets.push(`internal_note=$${args.length}`); }
    if (b.sentiment && ['positive', 'neutral', 'negative'].includes(b.sentiment)) { args.push(b.sentiment); sets.push(`sentiment=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    args.push(req.params.id);
    const r = await getPool().query(`UPDATE reviews SET ${sets.join(', ')} WHERE id=$${args.length} RETURNING *`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, review: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/reputation/reviews/:id/escalate
router.post('/reviews/:id/escalate', requirePerm('reviews.write'), async (req, res) => {
  try {
    const r = await getPool().query(`UPDATE reviews SET status='pending', escalated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    const rv = r.rows[0];
    await alertManager(`⚠️ <b>Ескалація відгуку</b>\nОцінка: ${'★'.repeat(rv.rating)} (${rv.rating}/5)\nМайстер: ${rv.master_name || '—'}\n${rv.text ? '«' + rv.text.slice(0, 300) + '»' : 'без тексту'}`);
    res.json({ ok: true, review: rv });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Настройки ───────────────────────────────────────────────────────
router.get('/settings', requirePerm('reports.read'), async (req, res) => {
  try { res.json(await getSettings(getPool())); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.patch('/settings', requirePerm('reviews.write'), async (req, res) => {
  try {
    const pool = getPool();
    const allowed = ['google_review_url', 'facebook_review_url', 'request_enabled', 'min_redirect_rating', 'request_cooldown_days', 'alert_low_rating'];
    const sets = [], args = [];
    for (const k of allowed) if (k in req.body) { args.push(req.body[k]); sets.push(`${k}=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    args.push(TENANT);
    await pool.query(`UPDATE reputation_settings SET ${sets.join(', ')}, updated_at=NOW() WHERE tenant_id=$${args.length}`, args);
    res.json(await getSettings(pool));
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Аналитика репутации ─────────────────────────────────────────────
router.get('/analytics', requirePerm('reports.read'), async (req, res) => {
  try {
    const pool = getPool();
    const base = await pool.query(
      `SELECT COUNT(*)::int total,
              ROUND(AVG(rating)::numeric,2) avg_rating,
              COUNT(*) FILTER (WHERE rating=5)::int r5,
              COUNT(*) FILTER (WHERE rating=4)::int r4,
              COUNT(*) FILTER (WHERE rating=3)::int r3,
              COUNT(*) FILTER (WHERE rating=2)::int r2,
              COUNT(*) FILTER (WHERE rating=1)::int r1,
              COUNT(*) FILTER (WHERE sentiment='positive')::int positive,
              COUNT(*) FILTER (WHERE sentiment='neutral')::int neutral,
              COUNT(*) FILTER (WHERE sentiment='negative')::int negative,
              COUNT(*) FILTER (WHERE reply IS NOT NULL)::int replied,
              COUNT(*) FILTER (WHERE status='pending')::int pending
         FROM reviews`);
    const b = base.rows[0];
    // NPS по 5★-шкале: промоутеры=5, детракторы<=3
    const promoters = b.r5, detractors = b.r1 + b.r2 + b.r3;
    const nps = b.total ? Math.round(((promoters - detractors) / b.total) * 100) : null;
    const trend = await pool.query(
      `SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month,
              COUNT(*)::int cnt, ROUND(AVG(rating)::numeric,2) avg_rating
         FROM reviews WHERE created_at > NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1`);
    res.json({
      total: b.total, avg_rating: b.avg_rating,
      distribution: { 5: b.r5, 4: b.r4, 3: b.r3, 2: b.r2, 1: b.r1 },
      sentiment: { positive: b.positive, neutral: b.neutral, negative: b.negative },
      nps, replied: b.replied, pending: b.pending,
      response_rate: b.total ? Math.round((b.replied / b.total) * 100) : null,
      trend: trend.rows,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Запрос отзыва у клиента (после визита) ──────────────────────────
// POST /api/reputation/request-review { client_id, appointment_id?, channel? }
router.post('/request-review', requirePerm('reviews.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { client_id, appointment_id, channel } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id-required' });
    const st = await getSettings(pool);
    if (!st.request_enabled) return res.status(400).json({ error: 'requests-disabled' });
    // лимит: не чаще 1 раза в N дней
    const recent = await pool.query(
      `SELECT 1 FROM review_request_log WHERE client_id=$1 AND created_at > NOW() - ($2 || ' days')::interval LIMIT 1`,
      [client_id, st.request_cooldown_days || 30]);
    if (recent.rowCount) return res.json({ ok: false, skipped: true, reason: 'cooldown' });
    const base = `${req.protocol}://${req.get('host')}`;
    const link = `${base}/p/feedback.html?c=${client_id}${appointment_id ? '&a=' + appointment_id : ''}`;
    const c = (await pool.query(`SELECT name FROM clients WHERE id=$1`, [client_id])).rows[0] || {};
    const body = `Дякуємо за візит${c.name ? ', ' + c.name : ''}! 💛\nБудь ласка, оцініть нас — це займе 10 секунд:\n${link}`;
    const out = await hub.enqueue({ clientId: client_id, channel, body, category: 'transactional', priority: 'low', dedupKey: appointment_id ? `review_req:${appointment_id}` : `review_req:${client_id}:${Date.now()}`, source: 'review-request' });
    await pool.query(
      `INSERT INTO review_request_log (client_id, appointment_id, channel) VALUES ($1,$2,$3)`,
      [client_id, appointment_id || null, out.channel || channel || null]);
    res.json({ ok: !out.skipped, ...out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Публичная двухступенчатая форма (без авторизации) ───────────────
// POST /api/reputation/feedback { client_id?, appointment_id?, client_phone?, rating, text?, master_id?, master_name?, service_name? }
router.post('/feedback', async (req, res) => {
  try {
    const pool = getPool();
    const b = req.body || {};
    const rating = parseInt(b.rating, 10);
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating-1-5-required' });
    const st = await getSettings(pool);
    const sentiment = sentimentOf(rating);
    const redirect = rating >= (st.min_redirect_rating || 4);
    // сохраняем отзыв: высокий — сразу published, низкий — pending (приватно, на модерацию)
    const status = redirect ? 'published' : 'pending';
    const ins = await pool.query(
      `INSERT INTO reviews (client_id, client_phone, appointment_id, master_id, master_name,
                            service_name, rating, text, sentiment, status, source, is_anonymous)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'internal',$11) RETURNING id`,
      [b.client_id || null, normalizePhoneDb(b.client_phone) || null, b.appointment_id || null, b.master_id || null,
       b.master_name || null, b.service_name || null, rating, String(b.text || '').slice(0, 2000) || null,
       sentiment, status, !!b.is_anonymous]);
    // отметить шаг в журнале запроса
    if (b.appointment_id || b.client_id) {
      await pool.query(
        `UPDATE review_request_log SET internal_rating=$1, completed=TRUE,
                redirected_to=$2
           WHERE id = (SELECT id FROM review_request_log
                       WHERE ($3::int IS NOT NULL AND appointment_id=$3) OR ($4::int IS NOT NULL AND client_id=$4)
                       ORDER BY created_at DESC LIMIT 1)`,
        [rating, redirect ? 'google' : null, b.appointment_id || null, b.client_id || null]).catch(() => {});
    }
    // негатив → алерт руководителю
    if (!redirect && st.alert_low_rating) {
      await alertManager(`🔴 <b>Негативний відгук</b> (${rating}/5)\nМайстер: ${b.master_name || '—'}\n${b.text ? '«' + String(b.text).slice(0, 300) + '»' : 'без коментаря'}\nКлієнт: ${b.client_phone || b.client_id || 'анонім'}`);
    }
    res.json({
      ok: true, id: ins.rows[0].id, rating, sentiment,
      redirect: redirect ? (st.google_review_url || null) : null,
      thanks: redirect ? 'Дякуємо! Будемо вдячні за відгук на Google.' : 'Дякуємо за чесний відгук — ми обовʼязково попрацюємо над цим.',
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
