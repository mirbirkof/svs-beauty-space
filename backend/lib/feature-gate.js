/* lib/feature-gate.js — API-захист платних фіч (SaaS-аудит 06.07).
   Раніше фічегейти працювали ЛИШЕ в UI (меню ховалось), а API був відкритий:
   Free-салон міг напряму POST /api/campaigns. Тепер requireFeature(key) → 403.

   Логіка: платформа — без обмежень; фіча дозволена якщо
   а) в плані тенанта plan_features(key).enabled = TRUE, АБО
   б) є активна ліцензія модуля з таким кодом (licenses + module_catalog).
   Немає плану/рядка фічі взагалі → fail-open (не ламаємо існуючих). */
const { getPool } = require('../db-pg');
const { isPlatformTenant, getTenantId } = require('./tenant');

const LEGACY_SLUG = { solo: 'free', pro: 'professional' };
const _cache = new Map(); // `${tenant}:${key}` → { ok, exp }
const TTL = 60 * 1000;

async function featureAllowed(key) {
  const pool = getPool();
  // tenant_licenses/licenses — платформенні таблиці БЕЗ RLS → фільтр tenant_id ЯВНИЙ,
  // інакше береться ліцензія випадкового сусіда (verify-аудит 06.07)
  const tid = getTenantId();
  if (!tid) return { ok: true, reason: 'no-tenant-ctx' };
  const pf = await pool.query(
    `SELECT pf.enabled, tl.status, tl.overrides
       FROM tenant_licenses tl
       JOIN saas_plans_v2 p ON p.slug = COALESCE($2::jsonb->>tl.plan_code, tl.plan_code)
       JOIN plan_features pf ON pf.plan_id = p.id AND pf.feature_key = $1
      WHERE tl.tenant_id = $3
      ORDER BY tl.updated_at DESC NULLS LAST LIMIT 1`,
    [key, JSON.stringify(LEGACY_SLUG), tid]);
  if (!pf.rows.length) return { ok: true, reason: 'no-plan-row' }; // fail-open
  // несплачений/скасований план → платні фічі гаснуть (past_due ставить білінг-тік)
  const badStatus = ['past_due', 'cancelled', 'suspended', 'expired'].includes(String(pf.rows[0].status || ''));
  if (pf.rows[0].enabled && !badStatus) return { ok: true, reason: 'plan' };
  // куплений аддон пишеться білінгом у tenant_licenses.overrides — раніше гейт його не читав
  // і оплачений модуль лишався 403 (аудит 06.07)
  try {
    const ov = pf.rows[0].overrides;
    if (!badStatus && ov && (ov[key] === true || ov[key.replace('.', '_')] === true)) {
      return { ok: true, reason: 'addon-override' };
    }
  } catch (_) {}
  // фіча вимкнена в плані — можливо куплена окремим модулем
  const lic = await pool.query(
    `SELECT 1 FROM licenses l JOIN module_catalog mc ON mc.id = l.module_id
      WHERE mc.code = $1 AND l.tenant_id = $2 AND l.status IN ('active','grace_period')
        AND (l.expires_at IS NULL OR l.expires_at > NOW() OR l.status='grace_period') LIMIT 1`,
    [key.replace('.', '_'), tid]);
  if (lic.rows.length) return { ok: true, reason: 'module-license' };
  return { ok: false };
}

function requireFeature(key) {
  return async (req, res, next) => {
    try {
      if (isPlatformTenant && isPlatformTenant()) return next();
      const ckey = `${req.tenant_id || 't'}:${key}`;
      const hit = _cache.get(ckey);
      if (hit && hit.exp > Date.now()) {
        if (hit.ok) return next();
        return res.status(403).json({ error: 'feature-locked', feature: key,
          message: `Функція «${key}» недоступна на вашому тарифі. Оновіть план або підключіть модуль.` });
      }
      const r = await featureAllowed(key);
      _cache.set(ckey, { ok: r.ok, exp: Date.now() + TTL });
      if (r.ok) return next();
      return res.status(403).json({ error: 'feature-locked', feature: key,
        message: `Функція «${key}» недоступна на вашому тарифі. Оновіть план або підключіть модуль.` });
    } catch (e) {
      console.error('[feature-gate]', key, e.message);
      return next(); // fail-open
    }
  };
}

function invalidateFeatureCache(tenantId) {
  for (const k of _cache.keys()) if (!tenantId || k.startsWith(tenantId + ':')) _cache.delete(k);
}

module.exports = { requireFeature, invalidateFeatureCache, featureAllowed };
