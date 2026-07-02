/* ═══════════════════════════════════════════════════════
   SVS CRM — Auth Core (shared utilities)

   Хеширование паролей: bcryptjs (cost factor 10)
   JWT: access token (15 min) + refresh token (cookie, 30 days / 14 days)
   Защита: rate-limit, lockout, password complexity, history check
   ═══════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TTL_SEC = 15 * 60;                 // 15 минут
const REFRESH_TTL_DAYS_DEFAULT = 14;            // обычная сессия
const REFRESH_TTL_DAYS_REMEMBER = 30;           // "Запам'ятати мене"
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 6);
const PASSWORD_HISTORY_DEPTH = 5;               // не повторять последние 5
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// JWT secret — берётся из env. Если нет — генерим эфемерный и предупреждаем.
function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (!global.__ephemeral_jwt_secret) {
    global.__ephemeral_jwt_secret = crypto.randomBytes(48).toString('hex');
    console.warn('[auth-core] JWT_SECRET missing or short. Using ephemeral secret — tokens invalidate on restart!');
  }
  return global.__ephemeral_jwt_secret;
}

// Аудит #12: ротация ключей JWT через kid (key id) без обрыва живых сессий.
//   • подпись — ВСЕГДА текущим ключом (JWT_SECRET), с kid в заголовке;
//   • проверка — по списку: текущий + предыдущий (JWT_SECRET_PREVIOUS).
// Сценарий ротации без разлогина:
//   1) выставить JWT_SECRET_PREVIOUS = старый JWT_SECRET;
//   2) JWT_SECRET = новый секрет, JWT_KID = новый id (напр. k2);
//   3) старые живые токены (подписаны старым) проходят проверку по PREVIOUS,
//      новые — по текущему. Через TTL access-токенов старый ключ можно убрать.
// Совместимость: токены, выпущенные ДО этого изменения (без kid), проверяются
// текущим JWT_SECRET — секрет не менялся, поэтому остаются валидными.
function currentKid() {
  return process.env.JWT_KID || 'k1';
}
// Список ключей для ПРОВЕРКИ: [текущий, предыдущий?]. Подпись — всегда [0].
function getJwtKeys() {
  const keys = [{ kid: currentKid(), secret: getJwtSecret() }];
  const prev = process.env.JWT_SECRET_PREVIOUS;
  if (prev && prev.length >= 32) {
    keys.push({ kid: process.env.JWT_KID_PREVIOUS || 'prev', secret: prev });
  }
  return keys;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return await bcrypt.compare(String(plain), hash); }
  catch { return false; }
}

// Минимальное требование: 6+ любых символов (по решению владельца)
function checkPasswordComplexity(pwd) {
  const s = String(pwd || '');
  const errors = [];
  // Решение Владельца 02.07 (заметка #92): минимальный пароль — 6 ЛЮБЫХ символов.
  // Требования к составу (буква+цифра) сняты по прямой просьбе. Влияет только на
  // новые пароли (reset/change), существующие хеши не трогаем.
  if (s.length < PASSWORD_MIN_LENGTH) errors.push(`min-length-${PASSWORD_MIN_LENGTH}`);
  return { ok: errors.length === 0, errors };
}

function signAccessToken(payload) {
  return jwt.sign(
    { ...payload, typ: 'access' },
    getJwtSecret(),
    { expiresIn: ACCESS_TTL_SEC, issuer: 'svs-crm', keyid: currentKid() }
  );
}

function verifyAccessToken(token) {
  // Берём kid из заголовка → пробуем сначала совпавший ключ, потом остальные.
  let preferKid = null;
  try {
    const decodedHead = jwt.decode(token, { complete: true });
    preferKid = decodedHead && decodedHead.header && decodedHead.header.kid || null;
  } catch { /* ignore */ }
  const keys = getJwtKeys();
  const ordered = preferKid
    ? [...keys.filter(k => k.kid === preferKid), ...keys.filter(k => k.kid !== preferKid)]
    : keys;
  for (const k of ordered) {
    try {
      const decoded = jwt.verify(token, k.secret, { issuer: 'svs-crm' });
      if (decoded.typ !== 'access') return null;
      return decoded;
    } catch { /* пробуем следующий ключ */ }
  }
  return null;
}

function generateRefreshToken() {
  return 'rt_' + crypto.randomBytes(32).toString('hex');
}

function refreshTtlMs(rememberMe) {
  const days = rememberMe ? REFRESH_TTL_DAYS_REMEMBER : REFRESH_TTL_DAYS_DEFAULT;
  return days * 86400 * 1000;
}

function gen6digit() {
  return String(crypto.randomInt(100000, 1000000));
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Очень короткий парсер device_label из User-Agent
function deviceLabelFromUA(ua) {
  if (!ua) return 'Unknown';
  let device = 'Browser';
  let os = 'Unknown OS';
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Macintosh/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Linux/.test(ua)) device = 'Linux';

  if (/Chrome\/(\d+)/.test(ua)) os = 'Chrome ' + RegExp.$1;
  else if (/Firefox\/(\d+)/.test(ua)) os = 'Firefox ' + RegExp.$1;
  else if (/Safari\/(\d+)/.test(ua) && !/Chrome/.test(ua)) os = 'Safari';
  else if (/Edg\/(\d+)/.test(ua)) os = 'Edge ' + RegExp.$1;

  return `${device} / ${os}`;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('380')) return '+' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.length === 9) return '+380' + digits;
  return '+' + digits;
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// Защита от перебора: считаем неудачные попытки за окно
async function recordAttempt(pool, { identifier, kind, success, ip, ua, meta }) {
  await pool.query(
    `INSERT INTO auth_attempts (identifier, kind, success, ip, user_agent, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [String(identifier || '').slice(0, 200), kind, !!success, ip || null, (ua || '').slice(0, 300), meta ? JSON.stringify(meta) : null]
  );
}

async function countRecentFailures(pool, identifier, kind, windowMinutes = 15) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM auth_attempts
     WHERE identifier = $1 AND kind = $2 AND success = false
       AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [identifier, kind, String(windowMinutes)]
  );
  return r.rows[0].cnt;
}

module.exports = {
  ACCESS_TTL_SEC,
  REFRESH_TTL_DAYS_DEFAULT,
  REFRESH_TTL_DAYS_REMEMBER,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  PASSWORD_HISTORY_DEPTH,
  PASSWORD_MIN_LENGTH,
  sha256,
  hashPassword,
  verifyPassword,
  checkPasswordComplexity,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  generateResetToken,
  refreshTtlMs,
  gen6digit,
  deviceLabelFromUA,
  clientIp,
  normalizePhone,
  normalizeEmail,
  recordAttempt,
  countRecentFailures,
};
