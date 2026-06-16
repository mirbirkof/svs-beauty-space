/* ═══════════════════════════════════════════════════════
   SAL-09 — Портфолио работ "До/После" (Before/After)
   Подключается как /api/portfolio

   Что закрывает:
   - CRUD работ мастеров: фото до/после + доп. фото, привязка к
     клиенту/мастеру/услуге/визиту, теги;
   - публичная галерея (/public) для сайта — только is_public=true;
   - фильтры: по мастеру, услуге, featured;
   - URL фото берутся из INF-02 (POST /api/files/upload вернёт url).

   Права: portfolio.read / portfolio.write (миграция 094).
   Публичная галерея — без авторизации.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/* ── ПУБЛИЧНАЯ ГАЛЕРЕЯ (без авторизации) — до requirePerm ── */
router.get('/public', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
    const params = [];
    let where = `tenant_id=current_tenant_id() AND is_public=true`;
    if (req.query.master_id) { params.push(req.query.master_id); where += ` AND master_id=$${params.length}`; }
    if (req.query.service_id) { params.push(req.query.service_id); where += ` AND service_id=$${params.length}`; }
    const rows = await q(
      `SELECT p.id, p.title, p.description, p.before_url, p.after_url, p.photo_urls, p.tags, p.featured,
              m.name AS master_name, s.name AS service_name
       FROM portfolio_items p
       LEFT JOIN masters m ON m.id=p.master_id
       LEFT JOIN services s ON s.id=p.service_id
       WHERE ${where}
       ORDER BY p.featured DESC, p.sort_order NULLS LAST, p.created_at DESC
       LIMIT ${limit}`, params);
    res.json({ data: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ── АВТОРИЗОВАННЫЕ ── */
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'portfolio.read' : 'portfolio.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/portfolio — список (админка)
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'p.tenant_id=current_tenant_id()';
    if (req.query.master_id) { params.push(req.query.master_id); where += ` AND p.master_id=$${params.length}`; }
    if (req.query.service_id) { params.push(req.query.service_id); where += ` AND p.service_id=$${params.length}`; }
    if (req.query.featured === '1') where += ' AND p.featured=true';
    const rows = await q(
      `SELECT p.*, m.name AS master_name, s.name AS service_name, c.name AS client_name
       FROM portfolio_items p
       LEFT JOIN masters m ON m.id=p.master_id
       LEFT JOIN services s ON s.id=p.service_id
       LEFT JOIN clients c ON c.id=p.client_id
       WHERE ${where} ORDER BY p.created_at DESC`, params);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/portfolio/:id
router.get('/:id', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM portfolio_items WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/portfolio — добавить работу
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.after_url) return res.status(400).json({ error: 'after_url_required' });
    const row = (await q(
      `INSERT INTO portfolio_items
        (title, description, before_url, after_url, photo_urls, client_id, master_id, service_id, appointment_id, tags, is_public, featured, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [b.title || null, b.description || null, b.before_url || null, b.after_url,
       JSON.stringify(Array.isArray(b.photo_urls) ? b.photo_urls : []),
       b.client_id || null, b.master_id || null, b.service_id || null, b.appointment_id || null,
       JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
       !!b.is_public, !!b.featured, b.sort_order || null, req.user?.id || null]))[0];
    await logAction({ user: req.user, action: 'portfolio.create', entity: 'portfolio_items', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/portfolio/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'description', 'before_url', 'after_url', 'photo_urls', 'client_id', 'master_id', 'service_id', 'appointment_id', 'tags', 'is_public', 'featured', 'sort_order'];
    const jsonCols = new Set(['photo_urls', 'tags']);
    const sets = [], params = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        params.push(jsonCols.has(k) ? JSON.stringify(req.body[k] || []) : req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE portfolio_items SET ${sets.join(', ')}, updated_at=now()
                          WHERE id=$${params.length} AND tenant_id=current_tenant_id() RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/portfolio/:id
router.delete('/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM portfolio_items WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'portfolio.delete', entity: 'portfolio_items', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
