/* INT-04 Marketplace — магазин расширений/плагинов.
 *
 * Каталог приложений по категориям, карточка (рейтинг, отзывы, changelog),
 * установка/удаление для тенанта с конфигом, developer-аккаунты, workflow
 * публикации (submit→review→approve/reject→publish) с авто security-scan по
 * запрашиваемым scope, рейтинг и отзывы, revenue-share (70/30), аналитика установок.
 *
 * GET   /api/marketplace/apps?category&q   — каталог опубликованных
 * GET   /api/marketplace/apps/:id          — карточка приложения + отзывы
 * POST  /api/marketplace/apps              — submit приложения (developer)
 * PATCH /api/marketplace/apps/:id/review   — модерация (approve/reject/publish)
 * POST  /api/marketplace/apps/:id/install  — установить для тенанта
 * DELETE/api/marketplace/apps/:id/install  — удалить
 * GET   /api/marketplace/installed         — установленные приложения
 * POST  /api/marketplace/apps/:id/reviews  — оставить отзыв
 * GET   /api/marketplace/developers        — dev-аккаунты
 * POST  /api/marketplace/developers        — регистрация dev
 */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('marketplace.read');
const MANAGE = requirePerm('marketplace.manage');

// scope'ы, требующие ручного review (потенциально чувствительные)
const SENSITIVE = ['clients.write','payments.read','payments.write','export','users.write'];

function securityScan(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const flagged = list.filter(s => SENSITIVE.includes(s));
  return { result: flagged.length ? 'failed' : 'passed', flagged };
}

// ── Каталог ──────────────────────────────────────────
router.get('/apps', READ, async (req, res) => {
  try {
    const where = [`status='published'`], vals = []; let i = 1;
    if (req.query.category) { where.push(`category=$${i++}`); vals.push(req.query.category); }
    if (req.query.q) { where.push(`(name ILIKE $${i} OR short_desc ILIKE $${i})`); vals.push(`%${req.query.q}%`); i++; }
    const r = await pool.query(
      `SELECT id,slug,name,category,short_desc,icon_url,version,price_model,price,rating,installs
       FROM mp_apps WHERE ${where.join(' AND ')} ORDER BY installs DESC, rating DESC LIMIT 200`, vals);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/apps/:id(\\d+)', READ, async (req, res) => {
  try {
    const a = await pool.query(`SELECT * FROM mp_apps WHERE id=$1`, [req.params.id]);
    if (!a.rowCount) return res.status(404).json({ error: 'not_found' });
    const reviews = await pool.query(
      `SELECT rating,body,author_name,created_at FROM mp_reviews WHERE app_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]);
    const installed = await pool.query(`SELECT id,config,status FROM mp_installs WHERE app_id=$1 LIMIT 1`, [req.params.id]);
    res.json({ ...a.rows[0], reviews: reviews.rows, installed: installed.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Публикация (developer) ───────────────────────────
router.post('/apps', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.slug) return res.status(400).json({ error: 'name_and_slug_required' });
    const scan = securityScan(b.scopes);
    const r = await pool.query(
      `INSERT INTO mp_apps (developer_id,slug,name,category,short_desc,description,icon_url,screenshots,
         iframe_url,scopes,version,changelog,price_model,price,status,security_scan)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'in_review',$15) RETURNING *`,
      [b.developer_id||null, b.slug, b.name, b.category||'other', b.short_desc||null, b.description||null,
       b.icon_url||null, JSON.stringify(b.screenshots||[]), b.iframe_url||null, JSON.stringify(b.scopes||[]),
       b.version||'1.0.0', b.changelog||null, b.price_model||'free', b.price||0, scan.result]);
    await logAction({ user: req.user, action: 'marketplace.submit', entity: 'mp_apps', entity_id: r.rows[0].id, ip: req.ip });
    res.status(201).json({ ...r.rows[0], security_scan: scan });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/apps/:id(\\d+)/review', MANAGE, async (req, res) => {
  try {
    const action = (req.body && req.body.action) || '';
    const note = (req.body && req.body.note) || null;
    const map = { approve:'approved', reject:'rejected', publish:'published' };
    const next = map[action];
    if (!next) return res.status(400).json({ error: 'bad_action', allowed: Object.keys(map) });
    const r = await pool.query(
      `UPDATE mp_apps SET status=$1, review_note=COALESCE($2,review_note), updated_at=NOW()
       WHERE id=$3 RETURNING *`, [next, note, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: `marketplace.${action}`, entity: 'mp_apps', entity_id: req.params.id, ip: req.ip });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Установка ────────────────────────────────────────
router.post('/apps/:id(\\d+)/install', MANAGE, async (req, res) => {
  try {
    const app = await pool.query(`SELECT id,status FROM mp_apps WHERE id=$1`, [req.params.id]);
    if (!app.rowCount) return res.status(404).json({ error: 'app_not_found' });
    if (app.rows[0].status !== 'published') return res.status(400).json({ error: 'app_not_published' });
    const token = 'mpt_' + crypto.randomBytes(16).toString('hex');
    const r = await pool.query(
      `INSERT INTO mp_installs (app_id,config,scoped_token,installed_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,app_id) DO UPDATE SET status='active', config=EXCLUDED.config
       RETURNING *`,
      [req.params.id, JSON.stringify(req.body?.config||{}), token, req.user?.id||null]);
    await pool.query(`UPDATE mp_apps SET installs=installs+1 WHERE id=$1`, [req.params.id]);
    await logAction({ user: req.user, action: 'marketplace.install', entity: 'mp_apps', entity_id: req.params.id, ip: req.ip });
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/apps/:id(\\d+)/install', MANAGE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM mp_installs WHERE app_id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_installed' });
    await pool.query(`UPDATE mp_apps SET installs=GREATEST(installs-1,0) WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/installed', READ, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT mi.id,mi.config,mi.status,mi.installed_at, a.id AS app_id,a.name,a.category,a.icon_url,a.version
       FROM mp_installs mi JOIN mp_apps a ON a.id=mi.app_id
       WHERE mi.status='active' ORDER BY mi.installed_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Отзывы ───────────────────────────────────────────
router.post('/apps/:id(\\d+)/reviews', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const rating = parseInt(b.rating, 10);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'rating_1_5_required' });
    await pool.query(
      `INSERT INTO mp_reviews (app_id,rating,body,author_name) VALUES ($1,$2,$3,$4)`,
      [req.params.id, rating, b.body||null, b.author_name || req.user?.display_name || null]);
    // пересчёт среднего рейтинга
    const avg = await pool.query(`SELECT ROUND(AVG(rating)::numeric,2) AS r FROM mp_reviews WHERE app_id=$1`, [req.params.id]);
    await pool.query(`UPDATE mp_apps SET rating=$1 WHERE id=$2`, [avg.rows[0].r || 0, req.params.id]);
    res.status(201).json({ ok: true, rating: avg.rows[0].r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Developers ───────────────────────────────────────
router.get('/developers', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id,name,email,verified,payout_share,created_at FROM mp_developers ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/developers', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    const r = await pool.query(
      `INSERT INTO mp_developers (name,email) VALUES ($1,$2) RETURNING *`, [b.name, b.email||null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
