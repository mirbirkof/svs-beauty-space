-- 270_solo_max_plan.sql (17.07.2026, приказ Босса)
-- Тариф «Майстер MAX» для соло: ВСЁ включено (все платные модули, вкл. AI Відеостудію).
-- 449₴/мес против 1343₴ за модули по отдельности — сильный бандл.

-- 1) Легаси-каталог (его читает /api/billing/plans и /api/saas/addons):
--    features='["*"]' → все модули «входить у тариф».
INSERT INTO saas_plans (code, name, price_month, price_year, features, limits, sort_order, active)
SELECT 'solo_max', 'Майстер MAX', 449.00, 4490.00,
       '["*"]'::jsonb,
       '{"clients":-1,"masters":1,"services":-1,"portfolio_photos":-1,"prepay":true}'::jsonb,
       2, true
WHERE NOT EXISTS (SELECT 1 FROM saas_plans WHERE code = 'solo_max');

-- 2) v2-каталог (его читают entitlements и feature-gate)
INSERT INTO saas_plans_v2 (slug, name, tier, price_monthly_uah, price_yearly_uah, trial_days, status, is_public, is_active, is_popular, contact_sales, sort_order, version, metadata)
SELECT 'solo_max', 'Майстер MAX', 2, 449.00, 4490.00, 14, 'published', true, true, false, false, 2, 1, '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM saas_plans_v2 WHERE slug = 'solo_max');

-- 3) Все известные фичи планов + все модули-аддоны → enabled=true для solo_max
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, fk.feature_key, true
  FROM saas_plans_v2 p,
       (SELECT DISTINCT feature_key FROM plan_features
        UNION SELECT DISTINCT feature_key FROM saas_addons WHERE active = true) fk
 WHERE p.slug = 'solo_max'
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = fk.feature_key);
