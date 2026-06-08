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
const PASSWORD_MIN_LENGTH = 8;
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

// Минимальные требования: 8+ символов, заглавная, строчная, цифра
function checkPasswordComplexity(pwd) {
  const s = String(pwd || '');
  const errors = [];
  if (s.length < PASSWORD_MIN_LENGTH) errors.push(`min-length-${PASSWORD_MIN_LENGTH}`);
  if (!/[A-ZА-ЯҐІЇЄ]/.test(s)) errors.push('no-uppercase');
  if (!/[a-zа-яґіїє]/.test(s)) errors.push('no-lowercase');
  if (!/[0-9]/.test(s)) errors.push('no-digit');
  return { ok: errors.length === 0, errors };
}

function signAccessToken(payload) {
  return jwt.sign(
    { ...payload, typ: 'access' },
    getJwtSecret(),
    { expiresIn: ACCESS_TTL_SEC, issuer: 'svs-crm' }
  );
}

function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { issuer: 'svs-crm' });
    if (decoded.typ !== 'access') return null;
    return decoded;
  } catch { return null; }
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
