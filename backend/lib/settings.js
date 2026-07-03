/* Глобальні налаштування CRM (app_settings) з легким кешем.
   getSetting(key, default) → value | default
   setSetting(key, value, userId)
   maskPhone(phone) → 'прихований' маскований номер */
const { getPool } = require('../db-pg');

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // key → { value, exp }

async function getSetting(key, def = null) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  try {
    const r = await getPool().query('SELECT value FROM app_settings WHERE key = $1', [key]);
    const value = r.rows[0] ? r.rows[0].value : def;
    cache.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return def; // якщо таблиці ще нема (міграція не пройшла) — повертаємо дефолт
  }
}

async function setSetting(key, value, userId = null) {
  const r = await getPool().query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING key, value`,
    [key, JSON.stringify(value), userId]
  );
  cache.delete(key);
  return r.rows[0];
}

async function getAllSettings() {
  const r = await getPool().query('SELECT key, value FROM app_settings ORDER BY key');
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

// Маскуємо номер: лишаємо лише останні 2 цифри → '••• ••89'
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  return '••• ••' + d.slice(-2);
}

/* Чи маскувати телефони клієнтів для цього юзера (вимога власника 03.07.2026):
   - маскуємо ТІЛЬКИ роль master;
   - майстер-одиночка (єдиний активний майстер у салоні) бачить номери завжди;
   - салон може відкрити номери тумблером masters_see_phone. */
let _mcCache = { n: null, exp: 0 };
async function activeMastersCount() {
  if (_mcCache.exp > Date.now() && _mcCache.n !== null) return _mcCache.n;
  try {
    const r = await getPool().query(`SELECT COUNT(*)::int AS n FROM masters WHERE active IS DISTINCT FROM false`);
    _mcCache = { n: r.rows[0].n, exp: Date.now() + 60 * 1000 };
    return _mcCache.n;
  } catch { return 2; } // невідомо → консервативно вважаємо салоном (маскуємо)
}

async function shouldMaskPhones(user) {
  if (!user || user.role !== 'master') return false;
  if ((await getSetting('masters_see_phone', false)) === true) return false;
  if ((await activeMastersCount()) <= 1) return false; // майстер-одиночка бачить
  return true;
}

module.exports = { getSetting, setSetting, getAllSettings, maskPhone, shouldMaskPhones };
