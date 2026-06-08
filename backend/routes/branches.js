/* Branches: справочник филиалов + назначение мастеров */
const express = require('express');
const { Pool } = require('pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM branches WHERE is_active=TRUE ORDER BY is_default DESC, id`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePerm('branches.write'), async (req, res) => {
  try {
    const { code, name, address, city, phone, timezone, working_hours, settings } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code, name required' });
    const r = await pool.query(
      `INSERT INTO branches (code, name, address, city, phone, timezone, working_hours, settings)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'Europe/Kyiv'),$7,$8) RETURNING *`,
      [code, name, address || null, city || null, phone || null, timezone || null,
       working_hours ? JSON.stringify(working_hours) : null,
       settings ? JSON.stringify(settings) : '{}']
    );
    await logAction({ user: req.user, action: 'branch.create', entity: 'branch', entity_id: r.rows[0].id, meta: { code, name } });
    res.json({ ok: true, branch: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', requirePerm('branches.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, address, city, phone, is_active, working_hours, settings } = req.body || {};
    const r = await pool.query(
      `UPDATE branches SET
         name = COALESCE($1,name),
         address = COALESCE($2,address),
         city = COALESCE($3,city),
         phone = COALESCE($4,phone),
         is_active = COALESCE($5,is_active),
         working_hours = COALESCE($6::jsonb, working_hours),
         settings = COALESCE($7::jsonb, settings)
       WHERE id=$8 RETURNING *`,
      [name || null, address || null, city || null, phone || null, is_active,
       working_hours ? JSON.stringify(working_hours) : null,
       settings ? JSON.stringify(settings) : null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'branch.update', entity: 'branch', entity_id: id });
    res.json({ ok: true, branch: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Назначить мастера в филиал
router.post('/:id/masters/:masterId', requirePerm('branches.write'), async (req, res) => {
  try {
    const { is_primary } = req.body || {};
    await pool.query(
      `INSERT INTO master_branches (master_id, branch_id, is_primary)
       VALUES ($1,$2,$3)
       ON CONFLICT (master_id, branch_id) DO UPDATE SET is_primary=EXCLUDED.is_primary`,
      [Number(req.params.masterId), Number(req.params.id), !!is_primary]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/masters/:masterId', requirePerm('branches.write'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM master_branches WHERE branch_id=$1 AND master_id=$2`,
      [Number(req.params.id), Number(req.params.masterId)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Метрики по филиалам (для дашборда владельца)
router.get('/stats/overview', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.code, b.name,
              (SELECT COUNT(*) FROM orders o WHERE o.branch_id=b.id AND o.status='paid' AND o.created_at >= NOW()-INTERVAL '30 days')::int AS orders_30d,
              (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.branch_id=b.id AND o.status='paid' AND o.created_at >= NOW()-INTERVAL '30 days')::numeric AS revenue_30d,
              (SELECT COUNT(*) FROM appointments a WHERE a.branch_id=b.id AND a.status='completed' AND a.start_at >= NOW()-INTERVAL '30 days')::int AS appts_30d,
              (SELECT COUNT(*) FROM master_branches mb WHERE mb.branch_id=b.id)::int AS masters
         FROM branches b WHERE b.is_active=TRUE ORDER BY b.id`
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
