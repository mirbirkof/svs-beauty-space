/* PII-crypto — шифрование персональных данных (телефоны, медданные) без поломки поиска.
   ── AES-256-GCM для самого значения (phone_enc) — расшифровывается для показа.
   ── HMAC-SHA256 «слепой индекс» (phone_bidx) — детерминированный отпечаток для
      поиска/дедупа: одинаковый телефон → одинаковый хеш, обратно не восстановить.
   Ключ PII_KEY (hex, 64 символа = 32 байта) из env. БЕЗ ключа — graceful no-op
   (available()=false), система работает по-старому на plaintext, ничего не ломается. */
const crypto = require('crypto');

const _hex = process.env.PII_KEY || '';
const KEY = /^[0-9a-fA-F]{64}$/.test(_hex) ? Buffer.from(_hex, 'hex') : null;

function available() { return KEY !== null; }

// Нормализация телефона: только цифры — стабильный отпечаток для '+380'/'380'/'0XX'.
function normPhone(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

function encrypt(plain) {
  if (!KEY || plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64'); // iv(12)+tag(16)+ct
}

function decrypt(b64) {
  if (!KEY || !b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

// Слепой индекс телефона: HMAC от нормализованных цифр. Детерминированный → поиск/дедуп.
function phoneBidx(plain) {
  if (!KEY || plain == null || plain === '') return null;
  const n = normPhone(plain);
  if (!n) return null;
  return crypto.createHmac('sha256', KEY).update(n).digest('hex');
}

// Генератор ключа для env (одноразово, вывести Боссу для вставки в Render).
function generateKey() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { available, encrypt, decrypt, phoneBidx, normPhone, generateKey };
