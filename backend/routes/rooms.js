/* Rooms: кабинеты / рабочие места салона (SAL-05) */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

router.get('/', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const r = await pool.query(
      `SELECT * FROM rooms ${all ? '' : 'WHERE active=TRUE'} ORDER BY sort_order, id`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePerm('settings.write'), async (req, res) => {
  try {
    const { name, color, capacity, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await pool.query(
      `INSERT INTO rooms (name, color, capacity, sort_order)
       VALUES ($1, COALESCE($2,'#7c5cff'), COALESCE($3,1), COALESCE($4,0)) RETURNING *`,
      [name, color || null, capacity || null, sort_order || null]
    );
    await logAction({ user: req.user, action: 'room.create', entity: 'room', entity_id: r.rows[0].id, meta: { name } });
    res.json({ ok: true, room: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', requirePerm('settings.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, color, capacity, active, sort_order } = req.body || {};
    const r = await pool.query(
      `UPDATE rooms SET
         name = COALESCE($1,name),
         color = COALESCE($2,color),
         capacity = COALESCE($3,capacity),
         active = COALESCE($4,active),
         sort_order = COALESCE($5,sort_order)
       WHERE id=$6 RETURNING *`,
      [name || null, color || null, capacity || null,
       (typeof active === 'boolean' ? active : null), sort_order, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'room.update', entity: 'room', entity_id: id });
    res.json({ ok: true, room: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('settings.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    // мягкое отключение, чтобы не рвать историю записей
    await pool.query(`UPDATE rooms SET active=FALSE WHERE id=$1`, [id]);
    await logAction({ user: req.user, action: 'room.disable', entity: 'room', entity_id: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
