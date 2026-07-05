/* RBAC — Role-Based Access Control middleware
   Использует Bearer token из header Authorization или X-Admin-Token (legacy).
   Совместимо со старым ADMIN_TOKEN — он = owner-level. */
const crypto = require('crypto');
const { getPool } = require('../db-pg');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Аудит #3: безопасное сравнение ADMIN_TOKEN (constant-time, против timing-атак).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

// Bootstrap-режим: при ADMIN_TOKEN_BOOTSTRAP_ONLY=1 мастер-токен работает ТОЛЬКО
// пока в системе нет ни одного активного owner-пользователя (первичная настройка).
// Как только реальный владелец заведён — legacy-токен автоматически отключается,
// закрывая постоянную owner-дыру в env. По умолчанию (флаг не задан) — старое
// поведение, ничего не ломается.
let _ownerExistsCache = { at: 0, val: null };
async function ownerUserExists() {
  const now = Date.now();
  if (_ownerExistsCache.val !== null && now - _ownerExistsCache.at < 30000) return _ownerExistsCache.val;
  try {
    const r = await getPool().query(
      `SELECT 1 FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.is_active = true AND r.level >= 900 LIMIT 1`);
    _ownerExistsCache = { at: now, val: r.rowCount > 0 };
  } catch { _ownerExistsCache = { at: now, val: false }; }
  return _ownerExistsCache.val;
}

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
  // 1) legacy ADMIN_TOKEN → виртуальный owner (timing-safe, аудит #3)
  if (process.env.ADMIN_TOKEN && safeEqual(token, process.env.ADMIN_TOKEN)) {
    // ТІЛЬКИ ПЛАТФОРМА (SaaS-аудит 06.07): легасі-токен один на весь інстанс, і якщо
    // приймати його в контексті САЛОНА-ОРЕНДАРЯ (X-Tenant-Slug) — будь-хто, хто його
    // дізнався, отримує owner-доступ до будь-якого салона. Орендарі — лише user-токени.
    try {
      const { isPlatformTenant } = require('./tenant');
      // саме === false: поза HTTP-контекстом isPlatformTenant() дає undefined —
      // скрипти/боти платформи не повинні втрачати токен (verify-аудит 06.07)
      if (isPlatformTenant && isPlatformTenant() === false) {
        console.warn('[rbac] ADMIN_TOKEN отклонён: запрос из tenant-контекста (не платформа)');
        return null;
      }
    } catch (_) { /* поза HTTP-контекстом (скрипти) — як раніше */ }
    // bootstrap-only: после появления реального owner мастер-токен отключается
    if (process.env.ADMIN_TOKEN_BOOTSTRAP_ONLY === '1' && await ownerUserExists()) {
      console.warn('[rbac] ADMIN_TOKEN отклонён: bootstrap-режим, владелец уже существует');
      return null;
    }
    console.warn('[rbac] вход по legacy ADMIN_TOKEN (owner-bypass) — рекомендуется завести именованного владельца');
    return { id: 0, display_name: 'legacy-admin', role: 'owner', role_level: 999, permissions: ['*'], branch_id: null };
  }
  // 2) user_tokens
  const hash = sha256(token);
  const r = await getPool().query(
    `SELECT u.id, u.display_name, u.branch_id, u.master_id, u.is_active,
            u.extra_permissions,
            r.code AS role, r.permissions, r.level AS role_level
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
  getPool().query(`UPDATE user_tokens SET last_used=NOW() WHERE token_hash=$1`, [hash]).catch(()=>{});
  const u = r.rows[0];
  // персональные права (тумблеры в «Керуванні доступом») поверх ролевых
  if (Array.isArray(u.extra_permissions) && u.extra_permissions.length) {
    u.permissions = [...new Set([...(u.permissions || []), ...u.extra_permissions])];
  }
  return u;
}

// Middleware фабрика: requirePerm('shop.write') или requirePerm() для просто авторизации
function requirePerm(perm) {
  return async function (req, res, next) {
    try {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      // query-токен разрешён ТОЛЬКО для GET (скачивание CSV через href, заголовки не выставить).
      // На мутациях (POST/PATCH/DELETE) токен из URL запрещён: вектор CSRF + утечка в логи/referer.
      const queryToken = req.method === 'GET' ? req.query.token : undefined;
      const token = bearer || req.headers['x-admin-token'] || queryToken;
      const user = await resolveUserByToken(token);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      if (perm && !hasPermission(user.permissions, perm)) {
        return res.status(403).json({ error: 'forbidden', need: perm });
      }
      req.user = user;
      // Аудит #2: зажать branch-параметры к филиалу привязанного юзера.
      // No-op для owner / одно-салонных (branch_id=null) — поведение не меняется.
      try { require('./branch-scope').enforceBranch(req); } catch (_) {}
      next();
    } catch (e) {
      console.error('[rbac]', e);
      res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
    }
  };
}

// Middleware: доступ ТОЛЬКО из контекста платформенного тенанта (оператор SaaS).
// Защита от эскалации: владелец салона получает роль owner с правами ["*"],
// поэтому requirePerm('saas.read') его НЕ остановит. Эти эндпоинты отдают
// кросс-тенантные данные (MRR/churn/список салонов/тикеты/white-label), их
// можно открывать только когда запрос идёт под платформенным тенантом
// (DEFAULT_TENANT / is_platform), а не под конкретным салоном.
function requirePlatform() {
  return function (req, res, next) {
    try {
      const { isPlatformTenant } = require('./tenant');
      if (!isPlatformTenant()) {
        return res.status(403).json({ error: 'platform_only' });
      }
      next();
    } catch (e) {
      return res.status(403).json({ error: 'platform_only' });
    }
  };
}

async function logAction({ user, action, entity, entity_id, ip, meta }) {
  try {
    await getPool().query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user?.id || null, user?.display_name || 'anon', action, entity || null, entity_id || null, ip || null, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) { /* не валим основной запрос */ }
  // INF-01: публикуем доменное событие в шину (best-effort, never throws).
  // Ленивый require, чтобы избежать циклов и не падать, если шина недоступна.
  try {
    const bus = require('./event-bus');
    bus.emit(`audit.${action}`, { entity, entity_id, meta }, {
      entityType: entity || null, entityId: entity_id || null,
      actor: user?.display_name || 'anon',
    });
  } catch (_) { /* шина опциональна */ }
}

module.exports = { requirePerm, requirePlatform, resolveUserByToken, hasPermission, logAction, sha256 };
