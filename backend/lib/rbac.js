/* RBAC — Role-Based Access Control middleware
   Использует Bearer token из header Authorization или X-Admin-Token (legacy).
   Совместимо со старым ADMIN_TOKEN — он = owner-level. */
const crypto = require('crypto');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Проверка одного permission. "*" покрывает всё. "shop.*" покрывает "shop.read".
function hasPermission(userPerms, required) {
  if (!Array.isArray(userPerms)) return false;
  if (userPerms.includes('*')) return true;
  if (userPerms.includes(required)) return true;
  // wildcard: "shop.*" matches "shop.read"
  const [reqArea] = required.split('.');
  if (userPerms.includes(`${reqArea}.*`)) return true;
  // suffix wildcard: "*.read" matches "shop.read"
  const reqAction = required.split('.').slice(-1)[0];
  if (userPerms.includes(`*.${reqAction}`)) return true;
  return false;
}

async function resolveUserByToken(token) {
  if (!token) return null;
  // 1) legacy ADMIN_TOKEN → виртуальный owner
  if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
    return { id: 0, display_name: 'legacy-admin', role: 'owner', permissions: ['*'], branch_id: null };
  }
  // 2) user_tokens
  const hash = sha256(token);
  const r = await pool.query(
    `SELECT u.id, u.display_name, u.branch_id, u.master_id, u.is_active,
            r.code AS role, r.permissions
       FROM user_tokens t
       JOIN users u ON u.id = t.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW())
      LIMIT 1`,
    [hash]
  );
  if (!r.rows[0]) return null;
  if (!r.rows[0].is_active) return null;
  // обновить last_used (fire-and-forget)
  pool.query(`UPDATE user_tokens SET last_used=NOW() WHERE token_hash=$1`, [hash]).catch(()=>{});
  return r.rows[0];
}

// Middleware фабрика: requirePerm('shop.write') или requirePerm() для просто авторизации
function requirePerm(perm) {
  return async function (req, res, next) {
    try {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const token = bearer || req.headers['x-admin-token'] || req.query.token;
      const user = await resolveUserByToken(token);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      if (perm && !hasPermission(user.permissions, perm)) {
        return res.status(403).json({ error: 'forbidden', need: perm });
      }
      req.user = user;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

async function logAction({ user, action, entity, entity_id, ip, meta }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user?.id || null, user?.display_name || 'anon', action, entity || null, entity_id || null, ip || null, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) { /* не валим основной запрос */ }
}

module.exports = { requirePerm, resolveUserByToken, hasPermission, logAction, sha256 };
