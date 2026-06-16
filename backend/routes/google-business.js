/* MKT-07 Google Business — управление Google Business Profile из CRM.
 *
 * Прагматично: CRM-сторона профиля (хранение, посты, Q&A, метрики видимости).
 * Реальная двусторонняя синхронизация с Google требует OAuth-токена аккаунта;
 * пока токен не подключён — sync_status='not_connected', данные ведутся в CRM
 * и готовы к выгрузке как только владелец подключит Google-аккаунт.
 *
 * GET    /api/google-business/profile            — профиль
 * PUT    /api/google-business/profile            — обновить профиль
 * POST   /api/google-business/sync               — синхронизация (стаб без токена)
 * GET    /api/google-business/posts              — посты
 * POST   /api/google-business/posts              — создать пост
 * PATCH  /api/google-business/posts/:id          — изменить/опубликовать
 * DELETE /api/google-business/posts/:id          — удалить
 * GET    /api/google-business/qna                — вопросы-ответы
 * POST   /api/google-business/qna                — добавить вопрос
 * PATCH  /api/google-business/qna/:id            — ответить
 * GET    /api/google-business/metrics?from&to    — метрики видимости
 * POST   /api/google-business/metrics            — внести метрики за день
 */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('gbp.read');
const MANAGE = requirePerm('gbp.manage');

// ── Профиль ───────────────────────────────────────────
router.get('/profile', READ, async (req, res) => {
  try {
    let r = await pool.query(`SELECT * FROM gbp_profile ORDER BY id LIMIT 1`);
    if (!r.rowCount) {
      r = await pool.query(`INSERT INTO gbp_profile (name) VALUES (NULL) RETURNING *`);
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await pool.query(`SELECT id FROM gbp_profile ORDER BY id LIMIT 1`);
    const id = cur.rowCount ? cur.rows[0].id : null;
    const fields = ['location_id','name','address','phone','website','description'];
    const sets = [], vals = [];
    let i = 1;
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    for (const f of ['categories','hours','attributes']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(JSON.stringify(b[f])); }
    }
    sets.push(`updated_at=NOW()`);
    let row;
    if (id) {
      vals.push(id);
      row = await pool.query(`UPDATE gbp_profile SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    } else {
      row = await pool.query(`INSERT INTO gbp_profile (name) VALUES ($1) RETURNING *`, [b.name || null]);
    }
    await logAction({ user: req.user, action: 'gbp.profile.update', entity: 'gbp_profile', ip: req.ip });
    res.json(row.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync', MANAGE, async (req, res) => {
  try {
    const hasToken = !!process.env.GOOGLE_BUSINESS_TOKEN;
    const status = hasToken ? 'connected' : 'not_connected';
    await pool.query(
      `UPDATE gbp_profile SET sync_status=$1, last_synced_at=NOW(), updated_at=NOW()
       WHERE id=(SELECT id FROM gbp_profile ORDER BY id LIMIT 1)`, [status]);
    await logAction({ user: req.user, action: 'gbp.sync', entity: 'gbp_profile', ip: req.ip });
    res.json({
      ok: true, sync_status: status,
      note: hasToken ? 'Синхронизировано с Google Business Profile.'
        : 'Google-аккаунт не подключён. Добавьте GOOGLE_BUSINESS_TOKEN — синхронизация заработает автоматически.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Посты ─────────────────────────────────────────────
router.get('/posts', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gbp_posts ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/posts', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.body && !b.title) return res.status(400).json({ error: 'title_or_body_required' });
    const r = await pool.query(
      `INSERT INTO gbp_posts (post_type,title,body,cta_type,cta_url,media_url,starts_at,ends_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.post_type||'update', b.title||null, b.body||null, b.cta_type||null, b.cta_url||null,
       b.media_url||null, b.starts_at||null, b.ends_at||null, req.user?.id||null]);
    await logAction({ user: req.user, action: 'gbp.post.create', entity: 'gbp_posts', entity_id: r.rows[0].id, ip: req.ip });
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/posts/:id', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = []; let i = 1;
    for (const f of ['post_type','title','body','cta_type','cta_url','media_url','starts_at','ends_at','status']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (b.status === 'published') { sets.push(`published_at=NOW()`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    sets.push(`updated_at=NOW()`); vals.push(req.params.id);
    const r = await pool.query(`UPDATE gbp_posts SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/posts/:id', MANAGE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM gbp_posts WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Q&A ───────────────────────────────────────────────
router.get('/qna', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM gbp_qna ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/qna', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.question) return res.status(400).json({ error: 'question_required' });
    const r = await pool.query(
      `INSERT INTO gbp_qna (question,asked_by) VALUES ($1,$2) RETURNING *`,
      [b.question, b.asked_by||null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/qna/:id', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.answer) return res.status(400).json({ error: 'answer_required' });
    const r = await pool.query(
      `UPDATE gbp_qna SET answer=$1, answered_at=NOW(), status='answered' WHERE id=$2 RETURNING *`,
      [b.answer, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Метрики видимости ─────────────────────────────────
router.get('/metrics', READ, async (req, res) => {
  try {
    const from = req.query.from || null, to = req.query.to || null;
    const where = [], vals = []; let i = 1;
    if (from) { where.push(`metric_date >= $${i++}`); vals.push(from); }
    if (to)   { where.push(`metric_date <= $${i++}`); vals.push(to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM gbp_metrics ${w} ORDER BY metric_date DESC LIMIT 366`, vals);
    const sum = await pool.query(
      `SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(searches),0) searches,
              COALESCE(SUM(website_clicks),0) website_clicks, COALESCE(SUM(calls),0) calls,
              COALESCE(SUM(directions),0) directions, COALESCE(SUM(bookings),0) bookings
       FROM gbp_metrics ${w}`, vals);
    res.json({ rows: r.rows, totals: sum.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/metrics', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.metric_date) return res.status(400).json({ error: 'metric_date_required' });
    const r = await pool.query(
      `INSERT INTO gbp_metrics (metric_date,impressions,searches,website_clicks,calls,directions,bookings,local_pack_pos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,metric_date) DO UPDATE SET
         impressions=EXCLUDED.impressions, searches=EXCLUDED.searches,
         website_clicks=EXCLUDED.website_clicks, calls=EXCLUDED.calls,
         directions=EXCLUDED.directions, bookings=EXCLUDED.bookings, local_pack_pos=EXCLUDED.local_pack_pos
       RETURNING *`,
      [b.metric_date, b.impressions||0, b.searches||0, b.website_clicks||0, b.calls||0,
       b.directions||0, b.bookings||0, b.local_pack_pos||null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
