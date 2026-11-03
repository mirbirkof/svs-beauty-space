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
  } catch (e) {
    // Аудит 13.08: раніше тут було мовчазне `return def`. Збій БД на секунду —
    // і налаштування салону підмінялося дефолтом (напр. paydesk_require_pin: true→false,
    // тобто каса відкривалася без PIN). Тепер: 1) збій видно в логах,
    // 2) тримаємо ОСТАННЄ ВІДОМЕ значення (навіть протухле) замість стрибка в дефолт.
    console.error('[settings] read failed', key, e.message);
    if (hit) return hit.value;
    return def; // справді немає що віддати (таблиці ще нема / перший запит)
  }
}

// Строгий варіант для критичних до безпеки ключів: помилка БД НЕ маскується дефолтом,
// а прокидається вгору — виклик сам вирішує (зазвичай: не відкривати доступ, віддати 503).
async function getSettingStrict(key, def = null) {
  const hit = cache.get(ck(key));
  if (hit && hit.exp > Date.now()) return hit.value;
  const tid = _getTenantId() || PLATFORM_TENANT_ID;
  const r = await getPool().query(
    `SELECT value FROM app_settings
      WHERE key = $1 AND tenant_id IN ($2::uuid, $3::uuid)
      ORDER BY (tenant_id = $2::uuid) DESC LIMIT 1`, [key, tid, PLATFORM_TENANT_ID]);
  const value = r.rows[0] ? r.rows[0].value : def;
  cache.set(ck(key), { value, exp: Date.now() + CACHE_TTL_MS });
  return value;
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
  // 03.11: було getTenantId() — такої змінної тут немає (імпорт _getTenantId) → ReferenceError → 500
  // у майстра на будь-якому списку з телефонами (з 13.08). Корінь: опечатка в імені.
  const tid = String(_getTenantId() || 'default');
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

module.exports = { getSetting, getSettingStrict, setSetting, getAllSettings, maskPhone, shouldMaskPhones };
