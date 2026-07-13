/* lib/plan-limits.js — ENFORCEMENT лімітів тарифного плану (SaaS-аудит 06.07).
   Раніше plan_limits існували лише «на папері»: Free-салон (max_employees=3) міг
   створити 1000 майстрів через API. Тепер створення понад ліміт блокується 403.

   Використання: router.post('/', enforcePlanLimit('max_employees',
     "SELECT COUNT(*)::int AS n FROM masters WHERE COALESCE(active,true)=true"), handler)

   Правила:
   - платформенний тенант (салон Босса) НЕ обмежується;
   - немає плану / немає ліміту в plan_limits → дозволяємо (fail-open, щоб не
     заблокувати роботу існуючих салонів через відсутній seed);
   - limit_value < 0 = безліміт;
   - is_soft=TRUE → не блокуємо, лише заголовок X-Plan-Limit-Warning. */
const { getPool } = require('../db-pg');
const { isPlatformTenant, getTenantId } = require('./tenant');

const LEGACY_SLUG = { solo: 'free', pro: 'professional' };

async function tenantLimit(pool, limitKey) {
  // tenant_licenses БЕЗ RLS → tenant_id фільтруємо явно (verify-аудит 06.07)
  const tid = getTenantId();
  if (!tid) return null;
  // Індивідуальний override ліміту (профіль підписника, ключ "limit:<key>" в overrides).
  // Задається оператором платформи в картці салону; має пріоритет над лімітом тарифу.
  const ov = await pool.query(
    `SELECT overrides->>('limit:'||$1) AS v FROM tenant_licenses WHERE tenant_id=$2 LIMIT 1`,
    [limitKey, tid]);
  const ovVal = ov.rows[0] && ov.rows[0].v;
  if (ovVal != null && ovVal !== '' && Number.isFinite(Number(ovVal)))
    return { limit_value: Number(ovVal), is_soft: false };
  const r = await pool.query(
    `SELECT pl.limit_value, pl.is_soft
       FROM tenant_licenses tl
       JOIN saas_plans_v2 p ON p.slug = COALESCE($2::jsonb->>tl.plan_code, tl.plan_code)
       JOIN plan_limits pl ON pl.plan_id = p.id AND pl.limit_key = $1
      WHERE tl.tenant_id = $3
      ORDER BY tl.updated_at DESC NULLS LAST LIMIT 1`,
    [limitKey, JSON.stringify(LEGACY_SLUG), tid]);
  return r.rows[0] || null;
}

function enforcePlanLimit(limitKey, countSql) {
  return async (req, res, next) => {
    try {
      if (isPlatformTenant && isPlatformTenant()) return next(); // салон платформи без лімітів
      const pool = getPool();
      const lim = await tenantLimit(pool, limitKey);
      if (!lim || lim.limit_value == null || Number(lim.limit_value) < 0) return next();
      const cur = await pool.query(countSql);
      const current = Number(cur.rows[0] && cur.rows[0].n) || 0;
      const limit = Number(lim.limit_value);
      if (current >= limit) {
        if (lim.is_soft) { res.set('X-Plan-Limit-Warning', `${limitKey}:${current}/${limit}`); return next(); }
        return res.status(403).json({
          error: 'plan-limit', limit_key: limitKey, limit, current,
          message: `Досягнуто ліміт тарифу (${limitKey}: ${current}/${limit}). Оновіть план, щоб додати більше.`,
        });
      }
      return next();
    } catch (e) {
      console.error('[plan-limits]', limitKey, e.message);
      return next(); // fail-open: помилка перевірки не повинна класти створення
    }
  };
}

// Пряма перевірка ліміту (для шляхів, де middleware не підходить — транзакції users.js).
// Повертає число (жорсткий ліміт) або null (безліміт/soft/платформа/нема плану).
async function getPlanLimit(limitKey) {
  if (isPlatformTenant && isPlatformTenant()) return null;
  const lim = await tenantLimit(getPool(), limitKey);
  if (!lim || lim.limit_value == null || Number(lim.limit_value) < 0 || lim.is_soft) return null;
  return Number(lim.limit_value);
}

module.exports = { enforcePlanLimit, getPlanLimit };
