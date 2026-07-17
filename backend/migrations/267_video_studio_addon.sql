-- 267_video_studio_addon.sql (17.07.2026, приказ Босса)
-- AI Відеостудія (монтаж Reels с озвучкой) как продукт:
--   • Мережа (Enterprise) — ВКЛЮЧЕНО в тариф
--   • остальные (соло, салон) — платный модуль 199₴/мес
-- Гейт fail-open при отсутствии строки плана → создаём ЯВНЫЕ строки для всех планов.

INSERT INTO saas_addons (feature_key, name, description, price_month, price_year, active)
SELECT 'video_studio', 'AI Відеостудія',
       'Готові Reels за хвилини: завантажте кліпи з телефона — студія сама змонтує ролик з переходами, титрами, ніжною озвучкою і музикою. Без монтажера і SMM-бюджету.',
       199.00, 1990.00, true
WHERE NOT EXISTS (SELECT 1 FROM saas_addons WHERE feature_key = 'video_studio');

-- Enterprise: включено в план
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, 'video_studio', true FROM saas_plans_v2 p
WHERE p.slug = 'enterprise'
  AND NOT EXISTS (SELECT 1 FROM plan_features pf WHERE pf.plan_id = p.id AND pf.feature_key = 'video_studio');

-- Остальные планы: выключено (доступно через аддон/лицензию)
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, 'video_studio', false FROM saas_plans_v2 p
WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro')
  AND NOT EXISTS (SELECT 1 FROM plan_features pf WHERE pf.plan_id = p.id AND pf.feature_key = 'video_studio');
