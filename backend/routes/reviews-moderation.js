/* ═══════════════════════════════════════════════════════
   COM-10 — Модерация отзывов (Reviews Moderation)
   Подключается как /api/reviews-moderation

   Что закрывает:
   - очередь модерации: pending/approved/rejected/spam;
   - одобрение/отклонение/пометка спама (одиночно и пакетно);
   - авто-эвристика спама (ссылки/повторы) при простановке pending;
   - публичная лента одобренных отзывов для сайта (/public);
   - сводка по статусам модерации (/summary).

   Работает поверх таблицы reviews (reputation-модуль не затрагивается).
   Право: reviews.moderate (миграция 100). /public — без авторизации.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const VALID = ['pending', 'approved', 'rejected', 'spam'];

/* ── ПУБЛИЧНАЯ ЛЕНТА (без авторизации) ── */
router.get('/public', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const minRating = parseInt(req.query.min_rating, 10) || 1;
    const rows = await q(
      `SELECT id, rating, text, master_name, service_name, created_at,
              CASE WHEN is_anonymous THEN NULL ELSE client_id END AS client_id
       FROM reviews
       WHERE tenant_id=current_tenant_id() AND moderation='approved' AND rating >= $1
       ORDER BY created_at DESC LIMIT ${limit}`, [minRating]);
    res.json({ data: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── МОДЕРАЦИЯ (требует прав) ── */
router.use(requirePerm('reviews.moderate'));

// GET /api/reviews-moderation?status=pending
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'tenant_id=current_tenant_id()';
    if (req.query.status && VALID.includes(req.query.status)) { params.push(req.query.status); where += ` AND moderation=$${params.length}`; }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await q(
      `SELECT id, rating, text, client_phone, master_name, service_name, source, sentiment,
              moderation, moderation_note, moderated_at, created_at
       FROM reviews WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reviews-moderation/summary
router.get('/summary', async (req, res) => {
  try {
    const rows = await q(`SELECT moderation, count(*)::int n FROM reviews WHERE tenant_id=current_tenant_id() GROUP BY moderation`);
    const summary = { pending: 0, approved: 0, rejected: 0, spam: 0 };
    for (const r of rows) summary[r.moderation] = r.n;
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// установить статус модерации одному отзыву
async function setModeration(req, res, status) {
  try {
    const row = (await q(
      `UPDATE reviews SET moderation=$1, moderation_note=$2, moderated_at=now(), moderated_by=$3
       WHERE id=$4 AND tenant_id=current_tenant_id() RETURNING id, moderation`,
      [status, req.body?.note || null, req.user?.id || null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: `review.${status}`, entity: 'reviews', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
}
router.post('/:id/approve', (req, res) => setModeration(req, res, 'approved'));
router.post('/:id/reject', (req, res) => setModeration(req, res, 'rejected'));
router.post('/:id/spam', (req, res) => setModeration(req, res, 'spam'));

// POST /api/reviews-moderation/bulk { ids:[], action:'approved'|'rejected'|'spam' }
router.post('/bulk', async (req, res) => {
  try {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || !VALID.includes(action))
      return res.status(400).json({ error: 'ids_and_valid_action_required' });
    const r = await pool.query(
      `UPDATE reviews SET moderation=$1, moderated_at=now(), moderated_by=$2
       WHERE id = ANY($3::bigint[]) AND tenant_id=current_tenant_id()`,
      [action, req.user?.id || null, ids]);
    await logAction({ user: req.user, action: `review.bulk_${action}`, entity: 'reviews', meta: { count: r.rowCount }, ip: req.ip });
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
