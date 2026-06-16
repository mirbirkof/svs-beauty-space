/* ═══════════════════════════════════════════════════════
   CRM-03 — ТЕГИ КЛІЄНТІВ
   Каталог тегів (з кольорами) + привʼязка many-to-many до клієнтів.
   Гейт: admin.* (керування клієнтами доступне лише адмінам).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
router.use(requirePerm('admin.*'));

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яёіїєґ]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/* ─── GET / — каталог тегів з лічильником клієнтів ─── */
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.*, COALESCE(cnt.c, 0)::int AS clients_count
         FROM client_tag_defs d
         LEFT JOIN (SELECT tag_id, COUNT(*) c FROM client_tags GROUP BY tag_id) cnt ON cnt.tag_id = d.id
        ORDER BY d.sort_order, LOWER(d.name)`);
    res.json({ items: r.rows, total: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── POST / — створити тег ─── */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name_required' });
    const dup = await pool.query(`SELECT 1 FROM client_tag_defs WHERE LOWER(name)=LOWER($1)`, [b.name.trim()]);
    if (dup.rowCount) return res.status(409).json({ error: 'name_exists' });
    const r = await pool.query(
      `INSERT INTO client_tag_defs (name, slug, color, description, sort_order)
       VALUES ($1,$2,COALESCE($3,'#6b7280'),$4,COALESCE($5,0)) RETURNING *`,
      [b.name.trim(), slugify(b.slug || b.name), b.color || null, b.description || null, b.sort_order]);
    await logAction({ user: req.user, action: 'client_tag.create', entity: 'client_tag', entity_id: r.rows[0].id, meta: { name: b.name } });
    res.json({ ok: true, tag: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── PATCH /:id — перейменувати/перефарбувати ─── */
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const cur = await pool.query(`SELECT * FROM client_tag_defs WHERE id=$1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    if (b.name !== undefined && b.name.trim() && b.name.trim().toLowerCase() !== cur.rows[0].name.toLowerCase()) {
      const dup = await pool.query(`SELECT 1 FROM client_tag_defs WHERE LOWER(name)=LOWER($1) AND id<>$2`, [b.name.trim(), id]);
      if (dup.rowCount) return res.status(409).json({ error: 'name_exists' });
    }
    const sets = [], vals = [];
    const set = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
    if (b.name !== undefined && b.name.trim()) { set('name', b.name.trim()); set('slug', slugify(b.name)); }
    if (b.color !== undefined) set('color', b.color);
    if (b.description !== undefined) set('description', b.description);
    if (b.sort_order !== undefined) set('sort_order', b.sort_order);
    if (!sets.length) return res.status(400).json({ error: 'no_fields' });
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await pool.query(`UPDATE client_tag_defs SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    await logAction({ user: req.user, action: 'client_tag.update', entity: 'client_tag', entity_id: id, meta: { fields: Object.keys(b) } });
    res.json({ ok: true, tag: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── DELETE /:id — видалити тег (привʼязки знімаються каскадом) ─── */
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(`SELECT * FROM client_tag_defs WHERE id=$1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    if (cur.rows[0].is_system) return res.status(409).json({ error: 'system_tag' });
    await pool.query(`DELETE FROM client_tag_defs WHERE id=$1`, [id]);
    await logAction({ user: req.user, action: 'client_tag.delete', entity: 'client_tag', entity_id: id, meta: { name: cur.rows[0].name } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── GET /client/:clientId — теги клієнта ─── */
router.get('/client/:clientId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.name, d.color FROM client_tags ct
         JOIN client_tag_defs d ON d.id = ct.tag_id
        WHERE ct.client_id = $1 ORDER BY d.sort_order, LOWER(d.name)`, [parseInt(req.params.clientId, 10)]);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── POST /assign — навісити тег ─── */
router.post('/assign', async (req, res) => {
  try {
    const clientId = parseInt(req.body.client_id, 10);
    const tagId = parseInt(req.body.tag_id, 10);
    if (!clientId || !tagId) return res.status(400).json({ error: 'client_id_and_tag_id_required' });
    const cl = await pool.query(`SELECT 1 FROM clients WHERE id=$1`, [clientId]);
    if (!cl.rowCount) return res.status(404).json({ error: 'client_not_found' });
    const tg = await pool.query(`SELECT name FROM client_tag_defs WHERE id=$1`, [tagId]);
    if (!tg.rowCount) return res.status(404).json({ error: 'tag_not_found' });
    await pool.query(
      `INSERT INTO client_tags (client_id, tag_id, created_by_name) VALUES ($1,$2,$3)
       ON CONFLICT (client_id, tag_id) DO NOTHING`,
      [clientId, tagId, (req.user && (req.user.name || req.user.label)) || null]);
    await logAction({ user: req.user, action: 'client_tag.assign', entity: 'client', entity_id: clientId, meta: { tag: tg.rows[0].name } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─── POST /unassign — зняти тег ─── */
router.post('/unassign', async (req, res) => {
  try {
    const clientId = parseInt(req.body.client_id, 10);
    const tagId = parseInt(req.body.tag_id, 10);
    if (!clientId || !tagId) return res.status(400).json({ error: 'client_id_and_tag_id_required' });
    const tg = await pool.query(`SELECT name FROM client_tag_defs WHERE id=$1`, [tagId]);
    await pool.query(`DELETE FROM client_tags WHERE client_id=$1 AND tag_id=$2`, [clientId, tagId]);
    await logAction({ user: req.user, action: 'client_tag.unassign', entity: 'client', entity_id: clientId, meta: { tag: tg.rows[0] && tg.rows[0].name } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
