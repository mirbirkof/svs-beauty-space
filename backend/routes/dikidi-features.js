/* DikiDi-like features: reviews, favorites, blacklist, promotions
   Подключается в shop-api.js: app.use('/api', require('./routes/dikidi-features')) */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { authClient } = require('./cabinet-auth');
const router = express.Router();
const pool = getPool();

function normPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return '+' + d;
  if (d.length === 10 && d.startsWith('0')) return '+38' + d;
  return '+' + d;
}

/* ═══════════════ REVIEWS ═══════════════ */

// POST /api/reviews — клиент оставляет отзыв.
// Эндпоинт публичный (форма my.html без токена), поэтому:
// 1) отзыв попадает в 'pending' — публикует персонал через PATCH (модерация в админке)
// 2) rate limit: max 3 отзыва за 10 мин с одного IP
const reviewRate = new Map(); // ip -> { count, windowStart }
router.post('/reviews', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    const slot = reviewRate.get(ip);
    if (slot && now - slot.windowStart < 10 * 60 * 1000) {
      if (slot.count >= 3) return res.status(429).json({ error: 'too many reviews, try later' });
      slot.count++;
    } else {
      reviewRate.set(ip, { count: 1, windowStart: now });
      if (reviewRate.size > 5000) reviewRate.clear(); // не растём бесконечно
    }

    const { client_phone, master_id, master_name, service_id, service_name,
            rating, text, is_anonymous } = req.body || {};
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
    if (text && String(text).length > 2000) return res.status(400).json({ error: 'text too long (max 2000)' });
    const phone = normPhone(client_phone);
    const r = await pool.query(
      `INSERT INTO reviews (client_phone, master_id, master_name, service_id, service_name,
                            rating, text, is_anonymous, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id, created_at`,
      [phone, master_id || null, master_name || null, service_id || null, service_name || null,
       rating, String(text || '').slice(0, 2000) || null, !!is_anonymous]
    );
    res.json({ ok: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/reviews — публичный список с фильтрами
router.get('/reviews', async (req, res) => {
  try {
    const { master_id, service_id, rating, limit = 50 } = req.query;
    const where = ["status='published'"];
    const args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (service_id) { args.push(service_id); where.push(`service_id=$${args.length}`); }
    if (rating) { args.push(parseInt(rating)); where.push(`rating=$${args.length}`); }
    args.push(parseInt(limit));
    const r = await pool.query(
      `SELECT id, master_id, master_name, service_id, service_name, rating, text,
              is_anonymous, created_at,
              CASE WHEN is_anonymous THEN 'Аноним'
                   ELSE COALESCE(SUBSTRING(client_phone, 1, 4)||'***'||SUBSTRING(client_phone, 10), 'Гость')
              END AS display_name
       FROM reviews WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${args.length}`, args
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/reviews/stats/:master_id — средний рейтинг + распределение
router.get('/reviews/stats/:master_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              ROUND(AVG(rating)::numeric, 2) AS avg_rating,
              COUNT(*) FILTER (WHERE rating=5)::int AS r5,
              COUNT(*) FILTER (WHERE rating=4)::int AS r4,
              COUNT(*) FILTER (WHERE rating=3)::int AS r3,
              COUNT(*) FILTER (WHERE rating=2)::int AS r2,
              COUNT(*) FILTER (WHERE rating=1)::int AS r1
       FROM reviews WHERE master_id=$1 AND status='published'`,
      [req.params.master_id]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/reviews/:id — модерация (только персонал)
router.patch('/reviews/:id', requirePerm('reviews.write'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['published', 'hidden', 'pending'].includes(status)) return res.status(400).json({ error: 'bad status' });
    await pool.query(`UPDATE reviews SET status=$1 WHERE id=$2`, [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ FAVORITES ═══════════════ */

// POST /api/favorites — добавить в избранное (телефон берём из сессии кабинета)
router.post('/favorites', authClient(), async (req, res) => {
  try {
    const { kind, target_id, target_name } = req.body || {};
    if (!kind || !target_id) return res.status(400).json({ error: 'kind, target_id required' });
    if (!['master', 'service', 'product'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
    const phone = normPhone(req.client.phone);
    const r = await pool.query(
      `INSERT INTO favorites (client_phone, kind, target_id, target_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, client_phone, kind, target_id) DO NOTHING
       RETURNING id`,
      [phone, kind, target_id, target_name || null]
    );
    res.json({ ok: true, id: r.rows[0]?.id || null, already: !r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/favorites — убрать из избранного (только своё, по сессии)
router.delete('/favorites', authClient(), async (req, res) => {
  try {
    const { kind, target_id } = req.body || {};
    const phone = normPhone(req.client.phone);
    await pool.query(
      `DELETE FROM favorites WHERE client_phone=$1 AND kind=$2 AND target_id=$3`,
      [phone, kind, target_id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ВАЖНО: req.client в Node — встроенный алиас сокета, он есть ВСЕГДА.
// Поэтому авторизованного клиента кабинета определяем по req.client.id (ставит authClient).
function cabClient(req) {
  return req.client && typeof req.client.id !== 'undefined' && req.client.phone ? req.client : null;
}

// GET /api/favorites — клиент видит своё (по сессии), персонал — любого (по ?phone=)
router.get('/favorites', authClient({ optional: true }), (req, res, next) => {
  if (cabClient(req)) return next();
  return requirePerm('favorites.read')(req, res, next);
}, async (req, res) => {
  try {
    const me = cabClient(req);
    const phone = me ? normPhone(me.phone) : normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const { kind } = req.query;
    const args = [phone];
    let where = `client_phone=$1`;
    if (kind) { args.push(kind); where += ` AND kind=$2`; }
    const r = await pool.query(
      `SELECT id, kind, target_id, target_name, created_at FROM favorites WHERE ${where} ORDER BY created_at DESC`,
      args
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ BLACKLIST ═══════════════ */

// POST /api/blacklist — добавить (только персонал)
router.post('/blacklist', requirePerm('blacklist.write'), async (req, res) => {
  try {
    const { client_phone, reason, created_by } = req.body || {};
    const phone = normPhone(client_phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const r = await pool.query(
      `INSERT INTO blacklist (client_phone, reason, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, client_phone) DO UPDATE SET reason=$2, created_by=$3
       RETURNING id, created_at`,
      [phone, reason || null, created_by || 'admin']
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/blacklist/:phone — убрать (только персонал)
router.delete('/blacklist/:phone', requirePerm('blacklist.write'), async (req, res) => {
  try {
    const phone = normPhone(req.params.phone);
    await pool.query(`DELETE FROM blacklist WHERE client_phone=$1`, [phone]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/blacklist — список (только персонал: телефоны и причины = персональные данные)
router.get('/blacklist', requirePerm('blacklist.read'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM blacklist ORDER BY created_at DESC`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/blacklist/check/:phone — проверка перед записью (только персонал)
router.get('/blacklist/check/:phone', requirePerm('blacklist.read'), async (req, res) => {
  try {
    const phone = normPhone(req.params.phone);
    const r = await pool.query(`SELECT 1 FROM blacklist WHERE client_phone=$1`, [phone]);
    res.json({ blocked: r.rowCount > 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ PROMOTIONS ═══════════════ */

// POST /api/promotions — создать (только персонал)
router.post('/promotions', requirePerm('promo.write'), async (req, res) => {
  try {
    const { title, description, discount_pct, discount_uah, category,
            service_category, starts_at, ends_at, banner_url } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await pool.query(
      `INSERT INTO promotions (title, description, discount_pct, discount_uah, category,
                               service_category, starts_at, ends_at, banner_url)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, NOW()),$8,$9) RETURNING id`,
      [title, description || null, discount_pct || null, discount_uah || null,
       category || 'shop', service_category || null, starts_at || null, ends_at || null, banner_url || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/promotions — публичный список с фильтрами
router.get('/promotions', async (req, res) => {
  try {
    const { category, sort = 'newest' } = req.query;
    const where = ["is_active=true", "(ends_at IS NULL OR ends_at > NOW())"];
    const args = [];
    if (category) { args.push(category); where.push(`category=$${args.length}`); }
    const order = sort === 'discount' ? 'discount_pct DESC NULLS LAST, discount_uah DESC NULLS LAST'
                : sort === 'ending' ? 'ends_at ASC NULLS LAST'
                : 'created_at DESC';
    const r = await pool.query(
      `SELECT * FROM promotions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100`, args
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/promotions/:id (только персонал)
router.patch('/promotions/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const { is_active, title, discount_pct, ends_at } = req.body || {};
    const sets = [];
    const args = [];
    if (typeof is_active === 'boolean') { args.push(is_active); sets.push(`is_active=$${args.length}`); }
    if (title) { args.push(title); sets.push(`title=$${args.length}`); }
    if (typeof discount_pct === 'number') { args.push(discount_pct); sets.push(`discount_pct=$${args.length}`); }
    if (ends_at) { args.push(ends_at); sets.push(`ends_at=$${args.length}`); }
    if (!sets.length) return res.json({ ok: true, noop: true });
    args.push(req.params.id);
    await pool.query(`UPDATE promotions SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
