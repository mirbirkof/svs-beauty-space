/* Users + tokens management. Только owner/admin */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, sha256, logAction } = require('../lib/rbac');
const { hashPassword, checkPasswordComplexity, normalizePhone } = require('../lib/auth-core');

const router = express.Router();
const pool = getPool();

// GET /api/users — список
router.get('/', requirePerm('users.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.phone, u.email, u.display_name, u.username, r.code AS role, r.name AS role_name,
              u.master_id, u.branch_id, u.is_active, u.last_login_at, u.created_at,
              (u.password_hash IS NOT NULL) AS has_password
         FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/users — создать сотрудника (с паролем/логином, опц. авто-мастер)
router.post('/', requirePerm('users.write'), async (req, res) => {
  const client = await pool.connect();
  try {
    let { phone, email, display_name, role_code, master_id, branch_id,
          username, password, specialty, commission_pct, create_master } = req.body || {};
    if (!display_name || !role_code) return res.status(400).json({ error: 'display_name, role_code required' });
    const role = await client.query(`SELECT id, code FROM roles WHERE code=$1`, [role_code]);
    if (!role.rows[0]) return res.status(400).json({ error: 'bad-role' });
    phone = phone ? normalizePhone(phone) : null;

    // пароль (необов'язковий) — якщо заданий, перевіряємо складність і хешуємо
    let password_hash = null;
    if (password) {
      const cx = checkPasswordComplexity(password);
      if (!cx.ok) return res.status(400).json({ error: 'weak-password', details: cx.errors });
      password_hash = await hashPassword(password);
    }

    await client.query('BEGIN');

    // якщо роль майстер і просять — створюємо запис у masters і лінкуємо
    if (!master_id && (create_master || role.rows[0].code === 'master')) {
      const m = await client.query(
        `INSERT INTO masters (name, phone, specialty, commission_pct, active)
         VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [display_name, phone, specialty || null, commission_pct != null ? commission_pct : 40]
      );
      master_id = m.rows[0].id;
    }

    const r = await client.query(
      `INSERT INTO users (phone, email, display_name, role_id, master_id, branch_id, username, password_hash, is_active, password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text,true, CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [phone, email || null, display_name, role.rows[0].id, master_id || null, branch_id || null, username || null, password_hash]
    );
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'user.create', entity: 'user', entity_id: r.rows[0].id, meta: { display_name, role_code, has_password: !!password_hash, master_id } });
    res.json({ ok: true, id: r.rows[0].id, master_id: master_id || null });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    if (/duplicate key|unique/i.test(e.message)) return res.status(409).json({ error: 'duplicate', message: 'Телефон, email або логін вже зайняті' });
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

// POST /api/users/:id/password — власник/адмін встановлює або скидає пароль
router.post('/:id/password', requirePerm('users.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    const cx = checkPasswordComplexity(password);
    if (!cx.ok) return res.status(400).json({ error: 'weak-password', details: cx.errors });
    const hash = await hashPassword(password);
    const r = await pool.query(
      `UPDATE users SET password_hash=$1, password_changed_at=NOW(), failed_login_attempts=0, locked_until=NULL, updated_at=NOW()
       WHERE id=$2 RETURNING id`, [hash, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    await pool.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)`, [id, hash]).catch(()=>{});
    await logAction({ user: req.user, action: 'user.set-password', entity: 'user', entity_id: id, meta: {} });
    res.json({ ok: true, message: 'Пароль встановлено' });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/users/:id — видалення користувача
//   ?hard=1 → повне видалення з БД (залежні записи CASCADE)
//   без hard → м'яка деактивація (is_active=false)
router.delete('/:id', requirePerm('users.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'cannot-delete-self' });
    const hard = req.query.hard === '1' || req.query.hard === 'true';

    // захист: не дати видалити/деактивувати останнього активного власника
    const tgt = await pool.query(
      `SELECT u.id, r.code AS role FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [id]);
    if (!tgt.rows[0]) return res.status(404).json({ error: 'not-found' });
    if (tgt.rows[0].role === 'owner') {
      const owners = await pool.query(
        `SELECT COUNT(*)::int AS n FROM users u JOIN roles r ON r.id=u.role_id
          WHERE r.code='owner' AND u.is_active=TRUE AND u.id<>$1`, [id]);
      if (owners.rows[0].n === 0) return res.status(400).json({ error: 'cannot-remove-last-owner' });
    }

    if (hard) {
      const r = await pool.query(`DELETE FROM users WHERE id=$1 RETURNING id`, [id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
      await logAction({ user: req.user, action: 'user.delete', entity: 'user', entity_id: id, meta: { hard: true } });
      return res.json({ ok: true, deleted: true });
    }
    const r = await pool.query(`UPDATE users SET is_active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    await logAction({ user: req.user, action: 'user.deactivate', entity: 'user', entity_id: id, meta: {} });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/users/:id/tokens/:tid — отозвать
router.delete('/:id/tokens/:tid', requirePerm('users.write'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM user_tokens WHERE id=$1 AND user_id=$2`, [Number(req.params.tid), Number(req.params.id)]);
    await logAction({ user: req.user, action: 'token.revoke', entity: 'user', entity_id: Number(req.params.id), meta: { token_id: Number(req.params.tid) } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/audit — журнал
router.get('/audit/log', requirePerm('audit.read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const r = await pool.query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
