/* Перевірка Telegram WebApp initData (Mini App).
   Алгоритм з https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
     data_check_string = відсортовані "key=value" (без hash), зʼєднані '\n'
     secret_key        = HMAC_SHA256(key="WebAppData", msg=bot_token)
     hash              = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
   Той самий формат підписує й відповідь WebApp.requestContact (contact=…&auth_date=…&hash=…). */
const crypto = require('crypto');

function _secret(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
}
function _checkString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** → { ok:true, user, authDate, data } | { ok:false, reason } */
function verify(initData, botToken, maxAgeSec = 86400, nowSec = Math.floor(Date.now() / 1000)) {
  if (!botToken) return { ok: false, reason: 'no_token' };
  if (!initData || typeof initData !== 'string' || initData.length > 8192) return { ok: false, reason: 'empty' };
  let params;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, reason: 'parse' }; }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no_hash' };
  const calc = crypto.createHmac('sha256', _secret(botToken)).update(_checkString(params)).digest();
  const got = Buffer.from(hash, 'hex');
  if (got.length !== calc.length || !crypto.timingSafeEqual(got, calc)) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'no_auth_date' };
  if (nowSec - authDate > maxAgeSec) return { ok: false, reason: 'expired' };
  if (authDate - nowSec > 300) return { ok: false, reason: 'future' };
  const data = Object.fromEntries(params.entries());
  let user = null;
  try { user = data.user ? JSON.parse(data.user) : null; } catch { user = null; }
  return { ok: true, user, authDate, data };
}

/** Підпис (для тестів / QA-браузера). fields — обʼєкт; обʼєкти серіалізуються в JSON. */
function sign(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const hash = crypto.createHmac('sha256', _secret(botToken)).update(_checkString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

module.exports = { verify, sign };
