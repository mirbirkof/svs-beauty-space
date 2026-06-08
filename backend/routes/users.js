/* Users + tokens management. Только owner/admin */
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { requirePerm, sha256, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET /api/users — список
router.get('/', requirePerm('users.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.phone, u.email, u.display_name, r.code AS role, u.master_id, u.branch_id,
              u.is_active, u.last_login_at, u.created_at
         FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users — создать
router.post('/', requirePerm('users.write'), async (req, res) => {
  try {
    const { phone, email, display_name, role_code, master_id, branch_id } = req.body || {};
    if (!display_name || !role_code) return res.status(400).json({ error: 'display_name, role_code required' });
    const role = await pool.query(`SELECT id FROM roles WHERE code=$1`, [role_code]);
    if (!role.rows[0]) return res.status(400).json({ error: 'bad-role' });
    const r = await pool.query(
      `INSERT INTO users (phone, email, display_name, role_id, master_id, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [phone || null, email || null, display_name, role.rows[0].id, master_id || null, branch_id || null]
    );
    await logAction({ user: req.user, action: 'user.create', entity: 'user', entity_id: r.rows[0].id, meta: { display_name, role_code } });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/users/:id
router.patch('/:id', requirePerm('users.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { display_name, role_code, is_active, branch_id, master_id } = req.body || {};
    let roleId = null;
    if (role_code) {
      const r = await pool.query(`SELECT id FROM roles WHERE code=$1`, [role_code]);
      if (!r.rows[0]) return res.status(400).json({ error: 'bad-role' });
      roleId = r.rows[0].id;
    }
    const r = await pool.query(
      `UPDATE users SET
         display_name = COALESCE($1, display_name),
         role_id      = COALESCE($2, role_id),
         is_active    = COALESCE($3, is_active),
         branch_id    = COALESCE($4, branch_id),
         master_id    = COALESCE($5, master_id),
         updated_at   = NOW()
       WHERE id=$6 RETURNING id`,
      [display_name || null, roleId, is_active, branch_id || null, master_id || null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'user.update', entity: 'user', entity_id: id, meta: req.body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/:id/tokens — выпустить токен
router.post('/:id/tokens', requirePerm('users.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { label, ttl_days } = req.body || {};
    const u = await pool.query(`SELECT id FROM users WHERE id=$1 AND is_active=TRUE`, [id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'not-found' });
    const token = 'svs_' + crypto.randomBytes(24).toString('hex');
    const hash = sha256(token);
    const expires = ttl_days ? new Date(Date.now() + ttl_days * 86400 * 1000) : null;
    const r = await pool.query(
      `INSERT INTO user_tokens (user_id, token_hash, label, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [id, hash, label || null, expires]
    );
    await logAction({ user: req.user, action: 'token.issue', entity: 'user', entity_id: id, meta: { token_id: r.rows[0].id, label } });
    res.json({ ok: true, token, token_id: r.rows[0].id, expires_at: expires });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/users/:id/tokens/:tid — отозвать
router.delete('/:id/tokens/:tid', requirePerm('users.write'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM user_tokens WHERE id=$1 AND user_id=$2`, [Number(req.params.tid), Number(req.params.id)]);
    await logAction({ user: req.user, action: 'token.revoke', entity: 'user', entity_id: Number(req.params.id), meta: { token_id: Number(req.params.tid) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/me — кто я
router.get('/me', requirePerm(), async (req, res) => {
  res.json({ user: req.user });
});

// GET /api/roles — справочник
router.get('/roles/list', requirePerm('users.read'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT code, name, level, permissions FROM roles ORDER BY level DESC`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/audit — журнал
router.get('/audit/log', requirePerm('audit.read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const r = await pool.query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
