/* routes/entitlements.js — единая точка «что моему тарифу разрешено» (Босс 16.07.2026).
 * Фронт читает это на загрузке и решает: показать / скрыть / заблокировать(🔒) раздел.
 * GET /api/my/entitlements → { plan, is_solo, features:{key:bool}, tier_rank }
 * Соло-режим (solo_master_mode) — отдельный сигнал: одиночке прячем командные разделы.
 */
const express = require('express');
// Аудит 13.08: кеш останнього вдалого набору прав по тенанту (для деградації без fail-open).
const _lastGood = new Map();
function _tenantKey(req) {
  try { return require('../lib/tenant').getTenantId() || req.headers['x-tenant-slug'] || 'default'; }
  catch (_) { return req.headers['x-tenant-slug'] || 'default'; }
}

const router = express.Router();
const { getPool } = require('../db-pg');
const { getTenantId, isPlatformTenant } = require('../lib/tenant');

const TIER = { free: 0, solo: 0, solo_max: 2, starter: 1, pro: 2, professional: 2, enterprise: 3 };

router.get('/my/entitlements', async (req, res) => {
  try {
    const pool = getPool();
    const tid = getTenantId();
    // Платформа (салон Босса) — всё открыто, соло-режим по своему флагу.
    const platform = isPlatformTenant && isPlatformTenant();

    // 1) План тенанта
    let plan = 'professional';
    if (tid) {
      const p = await pool.query(
        `SELECT plan_code FROM tenant_licenses WHERE tenant_id=$1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [tid]);
      if (p.rows[0]?.plan_code) plan = String(p.rows[0].plan_code);
      else {
        const t = await pool.query(`SELECT plan FROM tenants WHERE id=$1`, [tid]);
        if (t.rows[0]?.plan) plan = String(t.rows[0].plan);
      }
    }
    const planSlug = ({ solo: 'free', pro: 'professional' })[plan] || plan;
    const tierRank = TIER[plan] ?? TIER[planSlug] ?? 2;

    // 1.5) Вертикаль бизнеса (beauty/fitness/dental) — фронт показывает только свои группы меню
    let businessType = 'beauty';
    try { businessType = await require('../lib/vertical').getVertical(); } catch (_) {}

    // 2) Соло-режим (per-tenant настройка)
    let isSolo = false;
    try {
      const { getSetting } = require('../lib/settings');
      isSolo = String(await getSetting('solo_master_mode', false)) === 'true';
    } catch (_) {}

    // 3) Разрешённые фичи плана (+ купленные модули-лицензии)
    const features = {};
    try {
      const rows = (await pool.query(
        `SELECT pf.feature_key, pf.enabled
           FROM plan_features pf JOIN saas_plans_v2 sp ON sp.id=pf.plan_id
          WHERE sp.slug=$1`, [planSlug])).rows;
      for (const r of rows) features[r.feature_key] = !!r.enabled;
      if (tid) {
        const lic = (await pool.query(
          `SELECT mc.code FROM licenses l JOIN module_catalog mc ON mc.id=l.module_id
            WHERE l.tenant_id=$1 AND l.status IN ('active','grace_period')
              AND (l.expires_at IS NULL OR l.expires_at > NOW() OR l.status='grace_period')`, [tid])).rows;
        for (const r of lic) features[String(r.code).replace('_', '.')] = true;
      }
    } catch (e) { console.error('[entitlements/features]', e.message); }

    const payload = {
      ok: true,
      plan: planSlug,
      tier_rank: platform ? 3 : tierRank,
      is_solo: isSolo,
      is_platform: !!platform,
      business_type: businessType,
      features,
    };
    // Аудит 13.08: запам'ятовуємо ОСТАННІЙ ВДАЛИЙ результат по тенанту, щоб при збої
    // віддати саме його, а не «всім професійний тариф» (обхід монетизації).
    try { _lastGood.set(String(_tenantKey(req)), { at: Date.now(), payload }); } catch (_) {}
    res.json(payload);
  } catch (e) {
    console.error('[entitlements] ЗБІЙ визначення тарифу', e.message);
    // Аудит 13.08: раніше тут був fail-open «plan: professional, tier_rank: 3» — будь-який
    // збій відкривав платні розділи всім тенантам. Тепер: віддаємо ОСТАННІЙ ВІДОМИЙ тариф
    // цього ж салону (робочий салон не блокуємо), а якщо його ще не було — чесний 503,
    // щоб інтерфейс показав помилку, а не подарував Enterprise.
    const cached = _lastGood.get(String(_tenantKey(req)));
    if (cached) return res.json({ ...cached.payload, degraded: true });
    res.status(503).json({ ok: false, error: 'entitlements-unavailable', degraded: true });
  }
});

module.exports = router;
