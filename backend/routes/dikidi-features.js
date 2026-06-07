/* DikiDi-like features: reviews, favorites, blacklist, promotions
   Подключается в shop-api.js: app.use('/api', require('./routes/dikidi-features')) */
const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function normPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return '+' + d;
  if (d.length === 10 && d.startsWith('0')) return '+38' + d;
  return '+' + d;
}

/* ═══════════════ REVIEWS ═══════════════ */

// POST /api/reviews — клиент оставляет отзыв
router.post('/reviews', async (req, res) => {
  try {
    const { client_phone, master_id, master_name, service_id, service_name,
            rating, text, is_anonymous } = req.body || {};
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
    const phone = normPhone(client_phone);
    const r = await pool.query(
      `INSERT INTO reviews (client_phone, master_id, master_name, service_id, service_name,
                            rating, text, is_anonymous, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'published') RETURNING id, created_at`,
      [phone, master_id || null, master_name || null, service_id || null, service_name || null,
       rating, text || null, !!is_anonymous]
    );
    res.json({ ok: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/reviews/:id — модерация (админ)
router.patch('/reviews/:id', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['published', 'hidden', 'pending'].includes(status)) return res.status(400).json({ error: 'bad status' });
    await pool.query(`UPDATE reviews SET status=$1 WHERE id=$2`, [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ FAVORITES ═══════════════ */

// POST /api/favorites — добавить в избранное
router.post('/favorites', async (req, res) => {
  try {
    const { client_phone, kind, target_id, target_name } = req.body || {};
    if (!client_phone || !kind || !target_id) return res.status(400).json({ error: 'client_phone, kind, target_id required' });
    if (!['master', 'service', 'product'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
    const phone = normPhone(client_phone);
    const r = await pool.query(
      `INSERT INTO favorites (client_phone, kind, target_id, target_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_phone, kind, target_id) DO NOTHING
       RETURNING id`,
      [phone, kind, target_id, target_name || null]
    );
    res.json({ ok: true, id: r.rows[0]?.id || null, already: !r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/favorites — убрать из избранного
router.delete('/favorites', async (req, res) => {
  try {
    const { client_phone, kind, target_id } = req.body || {};
    const phone = normPhone(client_phone);
    await pool.query(
      `DELETE FROM favorites WHERE client_phone=$1 AND kind=$2 AND target_id=$3`,
      [phone, kind, target_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/favorites?phone=...&kind=master
router.get('/favorites', async (req, res) => {
  try {
    const phone = normPhone(req.query.phone);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ BLACKLIST ═══════════════ */

// POST /api/blacklist — добавить (админ)
router.post('/blacklist', async (req, res) => {
  try {
    const { client_phone, reason, created_by } = req.body || {};
    const phone = normPhone(client_phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const r = await pool.query(
      `INSERT INTO blacklist (client_phone, reason, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (client_phone) DO UPDATE SET reason=$2, created_by=$3
       RETURNING id, created_at`,
      [phone, reason || null, created_by || 'admin']
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/blacklist/:phone — убрать
router.delete('/blacklist/:phone', async (req, res) => {
  try {
    const phone = normPhone(req.params.phone);
    await pool.query(`DELETE FROM blacklist WHERE client_phone=$1`, [phone]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/blacklist — список (админ)
router.get('/blacklist', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM blacklist ORDER BY created_at DESC`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/blacklist/check/:phone — проверка перед записью
router.get('/blacklist/check/:phone', async (req, res) => {
  try {
    const phone = normPhone(req.params.phone);
    const r = await pool.query(`SELECT 1 FROM blacklist WHERE client_phone=$1`, [phone]);
    res.json({ blocked: r.rowCount > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════ PROMOTIONS ═══════════════ */

// POST /api/promotions — создать (админ)
router.post('/promotions', async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/promotions/:id
router.patch('/promotions/:id', async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
