/* Users + tokens management. Только owner/admin */
const express = require('express');
const crypto = require('crypto');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, sha256, logAction } = require('../lib/rbac');
const { hashPassword, checkPasswordComplexity, normalizePhone } = require('../lib/auth-core');

const router = express.Router();
const pool = getPool();

// Каталог прав, які власник може ВИДАВАТИ співробітнику персонально (extra_permissions),
// понад його роль. Групи — для зручного UI у вкладці «Доступ» профілю (Босс 19.07).
// Видати можна лише те, що є у самого власника (перевірка hasPermission нижче).
const GRANTABLE_PERMS = [
  { key: 'clients.write',   group: 'Клієнти',   label: 'Редагувати клієнтів' },
  { key: 'clients.delete',  group: 'Клієнти',   label: 'Видаляти клієнтів' },
  { key: 'cashbox.write',   group: 'Каса',      label: 'Проводити операції каси' },
  { key: 'cashbox.manage',  group: 'Каса',      label: 'Керувати касою (Z-звіт, корекції)' },
  { key: 'reports.read',    group: 'Звіти',     label: 'Дивитись звіти' },
  { key: 'reports.finance', group: 'Звіти',     label: 'Фінансові звіти (P&L, виручка)' },
  { key: 'masters.write',   group: 'Майстри',   label: 'Редагувати майстрів і послуги' },
  { key: 'masters.manage',  group: 'Майстри',   label: 'Наймати/звільняти майстрів' },
  { key: 'stock.write',     group: 'Склад',     label: 'Змінювати склад' },
  { key: 'stock.manage',    group: 'Склад',     label: 'Керувати складом (інвентаризація, списання)' },
  { key: 'shop.write',      group: 'Магазин',   label: 'Керувати товарами магазину' },
  { key: 'marketing.write', group: 'Маркетинг', label: 'Розсилки й акції' },
  { key: 'loyalty.write',   group: 'Маркетинг', label: 'Керувати лояльністю/бонусами' },
  { key: 'settings.write',  group: 'Налаштування', label: 'Змінювати налаштування салону' },
  { key: 'schedule.write',  group: 'Розклад',   label: 'Редагувати графіки роботи' },
  { key: 'documents.write', group: 'Документи', label: 'Керувати документами' },
  { key: 'export.read',     group: 'Дані',      label: 'Експорт даних (CSV)' },
];

// GET /api/users/grantable-perms — каталог прав для UI вкладки «Доступ» (тільки ті,
// що має сам власник → може їх видати). Гард users.write = лише власник/адмін з правом.
router.get('/grantable-perms', requirePerm('users.write'), async (req, res) => {
  try {
    const { hasPermission } = require('../lib/rbac');
    const items = GRANTABLE_PERMS.filter(p => hasPermission(req.user.permissions, p.key));
    res.json({ items });
  } catch (e) { console.error(e); res.status(500).json({ error: 'grantable-failed' }); }
});

// GET /api/users — список
router.get('/', requirePerm('users.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.phone, u.email, u.display_name, u.username, r.code AS role, r.name AS role_name,
              u.master_id, u.branch_id, u.is_active, u.last_login_at, u.created_at,
              u.extra_permissions,
              (u.password_hash IS NOT NULL) AS has_password
         FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/users/online — хто зараз онлайн + останній вхід. ТІЛЬКИ ВЛАСНИК.
// Джерело активності: user_tokens.last_used (оновлюється на кожному запиті адмінки).
// Онлайн = активність за останні 5 хв. Оголошено ДО параметричних /:id.
router.get('/online', requirePerm(), async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'owner') return res.status(403).json({ error: 'forbidden', message: 'Доступно лише власнику' });
    const r = await pool.query(
      `SELECT u.id, u.display_name, rr.code AS role, rr.name AS role_name, u.is_active,
              t.last_seen, u.last_login_at
         FROM users u
         JOIN roles rr ON rr.id = u.role_id
         LEFT JOIN (SELECT user_id, MAX(last_used) AS last_seen FROM user_tokens GROUP BY user_id) t ON t.user_id = u.id
        WHERE u.is_active
        ORDER BY t.last_seen DESC NULLS LAST, u.display_name`);
    const now = Date.now();
    const items = r.rows.map(x => {
      const seenMs = x.last_seen ? new Date(x.last_seen).getTime() : 0;
      return { id: x.id, display_name: x.display_name, role: x.role, role_name: x.role_name,
        last_seen: x.last_seen, last_login_at: x.last_login_at,
        online: !!seenMs && (now - seenMs) < 5 * 60 * 1000 };
    });
    res.json({ ok: true, items, online_count: items.filter(i => i.online).length, generated_at: new Date(now).toISOString() });
  } catch (e) { console.error('[users/online]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /api/users — создать сотрудника (с паролем/логином, опц. авто-мастер)
router.post('/', requirePerm('users.write'), async (req, res) => {
  const client = await pool.connect();
  try {
    let { phone, email, display_name, role_code, master_id, branch_id,
          username, password, specialty, commission_pct, create_master } = req.body || {};
    if (!display_name || !role_code) return res.status(400).json({ error: 'display_name, role_code required' });
    await applyTenant(client); // RLS ДО вибору ролі — інакше роль могла смэтчитись із чужого тенанта (аудит 06.07)
    const role = await client.query(`SELECT id, code, level FROM roles WHERE code=$1`, [role_code]);
    if (!role.rows[0]) return res.status(400).json({ error: 'bad-role' });
    // защита от эскалации: нельзя создать сотрудника с ролью выше собственной
    if ((role.rows[0].level || 0) > (req.user.role_level || 0)) {
      return res.status(403).json({ error: 'role-too-high', message: 'Нельзя назначить роль выше своей' });
    }
    phone = phone ? normalizePhone(phone) : null;

    // пароль (необов'язковий) — якщо заданий, перевіряємо складність і хешуємо
    let password_hash = null;
    if (password) {
      const cx = checkPasswordComplexity(password);
      if (!cx.ok) return res.status(400).json({ error: 'weak-password', details: cx.errors });
      password_hash = await hashPassword(password);
    }

    await client.query('BEGIN'); await applyTenant(client);

    // якщо роль майстер і просять — створюємо запис у masters і лінкуємо
    if (!master_id && (create_master || role.rows[0].code === 'master')) {
      // ліміт плану max_employees — цей шлях обходив enforcePlanLimit (аудит 06.07)
      const max = await require('../lib/plan-limits').getPlanLimit('max_employees').catch(() => null);
      if (max != null) {
        const cnt = await client.query(`SELECT COUNT(*)::int AS n FROM masters WHERE COALESCE(active,true)=true`);
        if (cnt.rows[0].n >= max) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'plan-limit', message: `Досягнуто ліміт тарифу (майстрів: ${cnt.rows[0].n}/${max}). Оновіть план.` });
        }
      }
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
    const { display_name, role_code, is_active, branch_id, master_id, extra_permissions } = req.body || {};
    // персональные тумблеры прав: белый список кодов + выдать можно только право, которое есть у самого выдающего.
    // Босс 19.07: власник керує всіма можливими правами адміна через вкладку «Доступ» у профілі.
    // Каталог групується у GRANTABLE_PERMS (той самий список читає фронт через /grantable-perms).
    const TOGGLABLE_PERMS = GRANTABLE_PERMS.map(p => p.key);
    let extraPerms = null; // null = не менять
    if (extra_permissions !== undefined) {
      if (!Array.isArray(extra_permissions)) return res.status(400).json({ error: 'extra_permissions-must-be-array' });
      const clean = [...new Set(extra_permissions.filter(p => TOGGLABLE_PERMS.includes(p)))];
      const { hasPermission } = require('../lib/rbac');
      for (const p of clean) {
        if (!hasPermission(req.user.permissions, p)) {
          return res.status(403).json({ error: 'perm-not-owned', message: 'Нельзя выдать право, которого нет у себя' });
        }
      }
      extraPerms = JSON.stringify(clean);
    }
    let roleId = null;
    if (role_code) {
      const r = await pool.query(`SELECT id, level FROM roles WHERE code=$1`, [role_code]);
      if (!r.rows[0]) return res.status(400).json({ error: 'bad-role' });
      // защита от эскалации: нельзя выдать роль выше собственной
      if ((r.rows[0].level || 0) > (req.user.role_level || 0)) {
        return res.status(403).json({ error: 'role-too-high', message: 'Нельзя назначить роль выше своей' });
      }
      roleId = r.rows[0].id;
    }
    // нельзя редактировать пользователя с ролью выше своей (эскалация через смену чужого owner)
    {
      const tgt = await pool.query(
        `SELECT r.level FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [id]);
      if (tgt.rows[0] && (tgt.rows[0].level || 0) > (req.user.role_level || 0)) {
        return res.status(403).json({ error: 'target-too-high', message: 'Нельзя редактировать пользователя с ролью выше своей' });
      }
    }
    const r = await pool.query(
      `UPDATE users SET
         display_name = COALESCE($1, display_name),
         role_id      = COALESCE($2, role_id),
         is_active    = COALESCE($3, is_active),
         branch_id    = COALESCE($4, branch_id),
         master_id    = COALESCE($5, master_id),
         extra_permissions = COALESCE($7::jsonb, extra_permissions),
         updated_at   = NOW()
       WHERE id=$6 RETURNING id`,
      [display_name || null, roleId, is_active, branch_id || null, master_id || null, id, extraPerms]
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
    // анти-ескалація (аудит v8): не можна випустити токен юзеру з роллю ВИЩЕ або РІВНОЮ своїй
    // (інакше admin мінтить сесію owner і забирає повний доступ). Себе — можна.
    const u = await pool.query(
      `SELECT u.id, COALESCE(r.level,0) AS level FROM users u
         LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND u.is_active=TRUE`, [id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'not-found' });
    if (id !== req.user.id && Number(u.rows[0].level) >= Number(req.user.role_level || 0))
      return res.status(403).json({ error: 'forbidden', message: 'Не можна видати токен користувачу з роллю не нижче вашої' });
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
    const tid = Number(req.params.tid), uid = Number(req.params.id);
    // анти-lockout (аудит v8): admin не рве сесії власника (роль ≥ своєї), окрім своїх
    if (uid !== req.user.id) {
      const tu = await pool.query(
        `SELECT COALESCE(r.level,0) AS level FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [uid]);
      if (tu.rows[0] && Number(tu.rows[0].level) >= Number(req.user.role_level || 0))
        return res.status(403).json({ error: 'forbidden', message: 'Не можна відкликати токени користувача з роллю не нижче вашої' });
    }
    await pool.query(`DELETE FROM user_tokens WHERE id=$1 AND user_id=$2`, [tid, uid]);
    await logAction({ user: req.user, action: 'token.revoke', entity: 'user', entity_id: uid, meta: { token_id: tid } });
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
