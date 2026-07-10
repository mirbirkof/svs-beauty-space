/* Секрети інтеграцій, що задаються з UI (а не лише з env Render).
 *
 * Як працює:
 *  - значення зберігаються в app_settings під ключем `integration:ENV_NAME`;
 *  - при старті сервера loadIntegrationSecrets() підвантажує їх у process.env
 *    ДЛЯ КЛЮЧІВ, ЯКИХ ЩЕ НЕМА в оточенні (env Render лишається авторитетним джерелом);
 *  - при збереженні з UI значення одразу кладеться в process.env → працює без рестарту.
 *
 * Безпека:
 *  - дозволені лише env-імена з білого списку (ALLOWED) — без довільного впису в оточення;
 *  - значення НІКОЛИ не віддаються назовні: API повертає тільки факт «налаштовано».
 */
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { getTenantId, DEFAULT_TENANT_ID } = require('./tenant');

// ── Шифрування секретів у спокої (at rest) ───────────────────────────────
// Ключ беремо з виділеної змінної INTEGRATION_ENC_KEY, а якщо її нема —
// деривуємо зі стабільного серверного секрету JWT_SECRET (живе лише в env Render).
// Дамп БД без доступу до env стає марним. Якщо надійного ключа нема зовсім —
// значення зберігаються як раніше (щоб нічого не зламати).
const ENC_TAG = 'enc:v1:';
function encKey() {
  const base = process.env.INTEGRATION_ENC_KEY || process.env.JWT_SECRET || '';
  if (!base || base.length < 8) return null;
  return crypto.scryptSync(base, 'integration-secrets-v1', 32);
}
function encryptVal(plain) {
  const key = encKey();
  if (!key) return String(plain); // нема ключа — без шифрування (legacy-сумісно)
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ENC_TAG + Buffer.concat([iv, tag, ct]).toString('base64');
}
function decryptVal(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(ENC_TAG)) return stored; // plaintext/legacy
  const key = encKey();
  if (!key) { console.error('[integration-secrets] encrypted value but no key available'); return ''; }
  try {
    const raw = Buffer.from(stored.slice(ENC_TAG.length), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { console.error('[integration-secrets] decrypt failed:', e.message); return ''; }
}

// Білий список env-імен, які можна задавати з UI (синхронізовано з каталогом integrations.js).
const ALLOWED = new Set([
  'MONO_TOKEN',
  'LIQPAY_PUBLIC_KEY', 'LIQPAY_PRIVATE_KEY',
  'GOOGLE_BUSINESS_TOKEN',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_NOTIFY_TOKEN',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
  'RESEND_API_KEY',
  'NOVAPOSHTA_API_KEY',
  'BEAUTYPRO_ID_KEY', 'BEAUTYPRO_SECRET_KEY', 'BEAUTYPRO_DATABASE_CODE',
  'GEMINI_API_KEY',
  // Instagram (Meta) — платформенный уровень: подпись и верификация вебхука.
  // Токены конкретного салона хранятся per-tenant в omni_channels.config.
  'META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_APP_ID',
]);

const PREFIX = 'integration:';

function isAllowed(name) { return ALLOWED.has(String(name || '').trim()); }

// Підвантажити збережені секрети в process.env (env Render має пріоритет — не перезаписуємо).
async function loadIntegrationSecrets() {
  try {
    const r = await getPool().query(
      `SELECT key, value FROM app_settings WHERE key LIKE $1 AND tenant_id = '00000000-0000-0000-0000-000000000001'`, [PREFIX + '%']
    );
    let loaded = 0;
    for (const row of r.rows) {
      const name = row.key.slice(PREFIX.length);
      if (!isAllowed(name)) continue;
      const stored = typeof row.value === 'string' ? row.value : (row.value == null ? '' : String(row.value));
      const val = decryptVal(stored);
      if (!val) continue;
      if (process.env[name] && String(process.env[name]).trim()) continue; // env пріоритетніший
      process.env[name] = val;
      loaded++;
    }
    if (loaded) console.log(`[integration-secrets] підвантажено з БД: ${loaded}`);
    return loaded;
  } catch (e) {
    console.error('[integration-secrets] load failed:', e.message);
    return 0;
  }
}

// Зберегти/очистити один секрет. Порожнє значення → видалити (повернутись до env, якщо є).
async function saveIntegrationSecret(name, value, userId = null) {
  name = String(name || '').trim();
  if (!isAllowed(name)) throw new Error('unknown integration key: ' + name);
  // Defense-in-depth: ці ключі пишуться в глобальний process.env усього інстансу.
  // Якщо є tenant-контекст і він НЕ платформенний — заборонити (щоб орендар не
  // перехопив платіжні/бот-ключі платформи навіть в обхід маршруту). Виклик без
  // контексту (скрипти, старт сервера) — дозволений.
  const tid = getTenantId();
  if (tid && tid !== DEFAULT_TENANT_ID) throw new Error('platform_only: integration secrets are platform-scoped');
  const pool = getPool();
  const v = (value == null ? '' : String(value)).trim();
  if (!v) {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [PREFIX + name]);
    return { name, set: false };
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, to_jsonb($2::text), $3, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [PREFIX + name, encryptVal(v), userId]
  );
  process.env[name] = v; // діє одразу, без рестарту
  return { name, set: true };
}

module.exports = { ALLOWED, isAllowed, loadIntegrationSecrets, saveIntegrationSecret, encryptVal, decryptVal };
