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
    if (req.query.category) { params.push(req.query.category); where += ` AND p.category=$${params.length}`; }
    if (req.query.status) { params.push(req.query.status); where += ` AND COALESCE(p.status,'uploaded')=$${params.length}`; }
    if (req.query.in_portfolio === '1') where += ' AND p.in_portfolio=true';
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

// ── GET /api/portfolio/stats — статистика фото ──
router.get('/stats', async (req, res) => {
  try {
    const params = [], wh = [`p.tenant_id=current_tenant_id()`, `COALESCE(p.status,'uploaded')<>'removed'`];
    if (req.query.master_id) { params.push(req.query.master_id); wh.push(`p.master_id=$${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); wh.push(`p.created_at >= $${params.length}::date`); }
    if (req.query.date_to) { params.push(req.query.date_to); wh.push(`p.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const w = wh.join(' AND ');
    const total = (await q(`SELECT COUNT(*)::int AS c FROM portfolio_items p WHERE ${w}`, params))[0].c;
    const byCategory = await q(`SELECT COALESCE(category,'other') AS category, COUNT(*)::int AS cnt FROM portfolio_items p WHERE ${w} GROUP BY category ORDER BY cnt DESC`, params);
    const topMasters = await q(
      `SELECT m.name AS master, COUNT(*)::int AS photos FROM portfolio_items p JOIN masters m ON m.id=p.master_id
        WHERE ${w} AND p.in_portfolio=true GROUP BY m.name ORDER BY photos DESC LIMIT 10`, params);
    const views = (await q(`SELECT COALESCE(SUM(view_count),0) AS v FROM portfolio_items p WHERE ${w}`, params))[0].v;
    res.json({ total_photos: total, photos_by_category: byCategory, top_employees: topMasters, total_views: Number(views) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/portfolio/consents — згоди клієнтів ──
router.get('/consents', async (req, res) => {
  try {
    const params = [], wh = [`tenant_id=current_tenant_id()`];
    if (req.query.client_id) { params.push(req.query.client_id); wh.push(`client_id=$${params.length}`); }
    if (req.query.status) { params.push(req.query.status); wh.push(`status=$${params.length}`); }
    const rows = await q(`SELECT * FROM photo_consents WHERE ${wh.join(' AND ')} ORDER BY granted_at DESC`, params);
    res.json({ items: rows, total: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/portfolio/consents — оформити згоду ──
router.post('/consents', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.consent_type || !b.signed_by_name)
      return res.status(400).json({ error: 'client_id, consent_type, signed_by_name required' });
    const row = (await q(
      `INSERT INTO photo_consents (client_id, consent_type, expires_at, signature_url, signed_by_name, document_url, collected_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.client_id, b.consent_type, b.expires_at || null, b.signature_url || null, b.signed_by_name, b.document_url || null, req.user?.id || null]))[0];
    res.json({ ok: true, consent: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/portfolio/consents/:id/revoke — відкликати згоду (знімає фото з публікації) ──
router.patch('/consents/:id/revoke', async (req, res) => {
  try {
    const consent = (await q(
      `UPDATE photo_consents SET status='revoked', revoked_at=now(), revoke_reason=$2, updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`, [req.params.id, req.body?.revoke_reason || null]))[0];
    if (!consent) return res.status(404).json({ error: 'not_found' });
    // знімаємо з публікації всі фото цього клієнта
    const upd = await q(`UPDATE portfolio_items SET is_public=false, status='moderated', updated_at=now()
       WHERE client_id=$1 AND tenant_id=current_tenant_id() AND is_public=true RETURNING id`, [consent.client_id]);
    res.json({ ok: true, consent, unpublished: upd.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/portfolio/master/:masterId — портфоліо майстра ──
router.get('/master/:masterId', async (req, res) => {
  try {
    const params = [req.params.masterId], wh = [`p.tenant_id=current_tenant_id()`, `p.master_id=$1`, `p.in_portfolio=true`, `COALESCE(p.status,'uploaded')<>'removed'`];
    if (req.query.category) { params.push(req.query.category); wh.push(`p.category=$${params.length}`); }
    const limit = Math.min(+req.query.limit || 50, 200);
    const photos = await q(
      `SELECT p.*, s.name AS service_name FROM portfolio_items p LEFT JOIN services s ON s.id=p.service_id
        WHERE ${wh.join(' AND ')} ORDER BY p.sort_order NULLS LAST, p.created_at DESC LIMIT ${limit}`, params);
    const master = (await q(`SELECT id, name, avatar, bio, rating FROM masters WHERE id=$1`, [req.params.masterId]))[0] || null;
    res.json({ employee: master, photos, total: photos.length });
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
    const allowed = ['title', 'description', 'before_url', 'after_url', 'photo_urls', 'client_id', 'master_id', 'service_id', 'appointment_id', 'tags', 'is_public', 'featured', 'sort_order', 'category', 'in_portfolio', 'shot_at'];
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

// ── PATCH /api/portfolio/:id/moderate — модерація (approve|reject) ──
router.patch('/:id/moderate', async (req, res) => {
  try {
    const action = req.body?.action;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action_must_be_approve_or_reject' });
    const status = action === 'approve' ? 'moderated' : 'rejected';
    const row = (await q(
      `UPDATE portfolio_items SET status=$2, moderated_by=$3, moderated_at=now(),
              rejection_reason=$4, updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`,
      [req.params.id, status, req.user?.id || null, action === 'reject' ? (req.body?.rejection_reason || null) : null]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: `portfolio.${action}`, entity: 'portfolio_items', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST /api/portfolio/bulk-moderate — масова модерація ──
router.post('/bulk-moderate', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(n => Number.isInteger(+n)) : [];
    const action = req.body?.action;
    if (!ids.length) return res.status(400).json({ error: 'ids_required' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action_must_be_approve_or_reject' });
    const status = action === 'approve' ? 'moderated' : 'rejected';
    const rows = await q(
      `UPDATE portfolio_items SET status=$2, moderated_by=$3, moderated_at=now(),
              rejection_reason=$4, updated_at=now()
       WHERE id = ANY($1::bigint[]) AND tenant_id=current_tenant_id() RETURNING id`,
      [ids, status, req.user?.id || null, action === 'reject' ? (req.body?.rejection_reason || null) : null]);
    res.json({ ok: true, updated: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/portfolio/:id/publish — публікація (вимагає активної згоди клієнта) ──
router.patch('/:id/publish', async (req, res) => {
  try {
    const item = (await q(`SELECT id, client_id FROM portfolio_items WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!item) return res.status(404).json({ error: 'not_found' });
    if (item.client_id) {
      const consent = (await q(
        `SELECT id FROM photo_consents
          WHERE client_id=$1 AND tenant_id=current_tenant_id() AND status='active'
            AND consent_type IN ('portfolio','social_media','advertising')
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`, [item.client_id]))[0];
      if (!consent) return res.status(409).json({ error: 'no_active_consent', message: 'Немає активної згоди клієнта на публікацію фото' });
    }
    const row = (await q(
      `UPDATE portfolio_items SET is_public=true, status='published', in_portfolio=true, updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`, [req.params.id]))[0];
    await logAction({ user: req.user, action: 'portfolio.publish', entity: 'portfolio_items', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── PATCH /api/portfolio/:id/unpublish — зняти з публікації ──
router.patch('/:id/unpublish', async (req, res) => {
  try {
    const row = (await q(
      `UPDATE portfolio_items SET is_public=false, status='moderated', updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'portfolio.unpublish', entity: 'portfolio_items', entity_id: row.id, ip: req.ip });
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
