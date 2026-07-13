/* Оцінка клієнта майстром/адміном (client_ratings, міграція 263).
   Босс: «щоб оцінки ставили і майстрам, і клієнтам» — це напрямок салон→клієнт.

   GET  /api/client-ratings/:clientId       — {avg, count, tags_summary, items[20]}
   POST /api/client-ratings  {client_id, appointment_id?, rating(1-5), tags[], comment}
        — одна оцінка на візит: якщо по appointment_id вже є — оновлюється.
   DELETE /api/client-ratings/:id           — власник/адмін прибирає помилкову оцінку.

   Доступ: будь-який залогінений співробітник (майстер теж ставить). RLS ізолює салони.
*/
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const ALLOWED_TAGS = ['запізнюється', 'no-show', 'конфліктний', 'торгується', 'топ-клієнт', 'пунктуальний'];

router.use(requirePerm());

router.get('/:clientId', async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'bad client id' });
    const agg = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*)::int AS count FROM client_ratings WHERE client_id = $1`,
      [clientId]
    );
    const tags = await pool.query(
      `SELECT t AS tag, COUNT(*)::int AS n FROM client_ratings, unnest(tags) t WHERE client_id = $1 GROUP BY t ORDER BY n DESC`,
      [clientId]
    );
    const items = await pool.query(
      `SELECT cr.id, cr.rating, cr.tags, cr.comment, cr.rated_by_name, cr.created_at,
              cr.appointment_id, m.name AS master_name
         FROM client_ratings cr LEFT JOIN masters m ON m.id = cr.master_id
        WHERE cr.client_id = $1 ORDER BY cr.created_at DESC LIMIT 20`,
      [clientId]
    );
    res.json({ ok: true, avg: agg.rows[0].avg ? Number(agg.rows[0].avg) : null, count: agg.rows[0].count, tags_summary: tags.rows, items: items.rows });
  } catch (e) {
    console.error('[client-ratings:get]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { client_id, appointment_id, rating, tags, comment } = req.body || {};
    const cid = Number(client_id);
    const rate = Number(rating);
    if (!Number.isInteger(cid)) return res.status(400).json({ error: 'client_id required' });
    if (!Number.isInteger(rate) || rate < 1 || rate > 5) return res.status(400).json({ error: 'rating 1-5 required' });
    const cleanTags = Array.isArray(tags) ? tags.filter((t) => ALLOWED_TAGS.includes(t)).slice(0, 6) : [];
    const apptId = Number.isInteger(Number(appointment_id)) && appointment_id ? Number(appointment_id) : null;
    const byName = (req.user && (req.user.display_name || req.user.login)) || null;
    const masterId = req.user && Number.isInteger(Number(req.user.master_id)) ? Number(req.user.master_id) : null;
    const cmt = comment ? String(comment).slice(0, 1000) : null;

    // клієнт має існувати у цьому салоні (RLS відфільтрує чужих)
    const cl = await pool.query('SELECT 1 FROM clients WHERE id = $1', [cid]);
    if (!cl.rowCount) return res.status(404).json({ error: 'client not found' });

    // одна оцінка на візит: partial unique → ON CONFLICT не можна, тому UPDATE-then-INSERT
    if (apptId) {
      const upd = await pool.query(
        `UPDATE client_ratings SET rating=$1, tags=$2, comment=$3, rated_by_name=$4, master_id=COALESCE($5, master_id), created_at=NOW()
          WHERE client_id=$6 AND appointment_id=$7 RETURNING id`,
        [rate, cleanTags, cmt, byName, masterId, cid, apptId]
      );
      if (upd.rowCount) return res.json({ ok: true, id: upd.rows[0].id, updated: true });
    }
    const ins = await pool.query(
      `INSERT INTO client_ratings (client_id, appointment_id, master_id, rated_by_name, rating, tags, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cid, apptId, masterId, byName, rate, cleanTags, cmt]
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) {
    console.error('[client-ratings:post]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const role = req.user && req.user.role;
    if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const r = await pool.query('DELETE FROM client_ratings WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[client-ratings:del]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

module.exports = router;
