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
const { getPool } = require('../db-pg');

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
]);

const PREFIX = 'integration:';

function isAllowed(name) { return ALLOWED.has(String(name || '').trim()); }

// Підвантажити збережені секрети в process.env (env Render має пріоритет — не перезаписуємо).
async function loadIntegrationSecrets() {
  try {
    const r = await getPool().query(
      `SELECT key, value FROM app_settings WHERE key LIKE $1`, [PREFIX + '%']
    );
    let loaded = 0;
    for (const row of r.rows) {
      const name = row.key.slice(PREFIX.length);
      if (!isAllowed(name)) continue;
      const val = typeof row.value === 'string' ? row.value : (row.value == null ? '' : String(row.value));
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
  const pool = getPool();
  const v = (value == null ? '' : String(value)).trim();
  if (!v) {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [PREFIX + name]);
    return { name, set: false };
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, to_jsonb($2::text), $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [PREFIX + name, v, userId]
  );
  process.env[name] = v; // діє одразу, без рестарту
  return { name, set: true };
}

module.exports = { ALLOWED, isAllowed, loadIntegrationSecrets, saveIntegrationSecret };
