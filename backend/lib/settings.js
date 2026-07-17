/* Глобальні налаштування CRM (app_settings) з легким кешем.
   getSetting(key, default) → value | default
   setSetting(key, value, userId)
   maskPhone(phone) → 'прихований' маскований номер */
const { getPool } = require('../db-pg');
let _getTenantId = () => null;
try { _getTenantId = require('./tenant').getTenantId; } catch (_) {}

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // `${tenant}:${key}` → { value, exp }
// КЕШ PER-TENANT (міграція 217): раніше значення Босса кешувалось і віддавалось
// іншим салонам протягом TTL.
const ck = (key) => `${_getTenantId() || 'platform'}:${key}`;

const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000001';

async function getSetting(key, def = null) {
  const hit = cache.get(ck(key));
  if (hit && hit.exp > Date.now()) return hit.value;
  try {
    // ЖОРСТКИЙ tenant-фільтр (фікс 17.07.2026): для платформи app.tenant_id порожній →
    // RLS permissive → запит без фільтра хапав рядок ЧУЖОГО тенанта (solo_master_mode
    // Зветли протік у салон Босса — там зʼявився вигляд соло-майстра). Тепер беремо
    // ТІЛЬКИ свій рядок; якщо його нема — рядок платформи (глобальний дефолт).
    const tid = _getTenantId() || PLATFORM_TENANT_ID;
    const r = await getPool().query(
      `SELECT value FROM app_settings
        WHERE key = $1 AND tenant_id IN ($2::uuid, $3::uuid)
        ORDER BY (tenant_id = $2::uuid) DESC LIMIT 1`, [key, tid, PLATFORM_TENANT_ID]);
    const value = r.rows[0] ? r.rows[0].value : def;
    cache.set(ck(key), { value, exp: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return def; // якщо таблиці ще нема (міграція не пройшла) — повертаємо дефолт
  }
}

async function setSetting(key, value, userId = null) {
  const r = await getPool().query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING key, value`,
    [key, JSON.stringify(value), userId]
  );
  cache.delete(ck(key));
  return r.rows[0];
}

async function getAllSettings() {
  // Той самий tenant-фільтр, що і в getSetting: свій рядок пріоритетніший за платформенний,
  // чужі тенанти не протікають.
  const tid = _getTenantId() || PLATFORM_TENANT_ID;
  const r = await getPool().query(
    `SELECT DISTINCT ON (key) key, value FROM app_settings
      WHERE tenant_id IN ($1::uuid, $2::uuid)
      ORDER BY key, (tenant_id = $1::uuid) DESC`, [tid, PLATFORM_TENANT_ID]);
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
// Крос-тенантний фікс: кеш кількості майстрів ПЕР-ТЕНАНТ. Був глобальний → «майстер-одиночка»
// vs «салон» визначалось числом ПЕРШОГО салону і застосовувалось до всіх (витік/невірна маска номерів).
const _mcCache = new Map();
async function activeMastersCount() {
  const tid = String(getTenantId() || 'default');
  const hit = _mcCache.get(tid);
  if (hit && hit.exp > Date.now() && hit.n !== null) return hit.n;
  try {
    const r = await getPool().query(`SELECT COUNT(*)::int AS n FROM masters WHERE active IS DISTINCT FROM false`);
    _mcCache.set(tid, { n: r.rows[0].n, exp: Date.now() + 60 * 1000 });
    return r.rows[0].n;
  } catch { return 2; } // невідомо → консервативно вважаємо салоном (маскуємо)
}

async function shouldMaskPhones(user) {
  if (!user || user.role !== 'master') return false;
  if ((await getSetting('masters_see_phone', false)) === true) return false;
  if ((await activeMastersCount()) <= 1) return false; // майстер-одиночка бачить
  return true;
}

module.exports = { getSetting, setSetting, getAllSettings, maskPhone, shouldMaskPhones };
