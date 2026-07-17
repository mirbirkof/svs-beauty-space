-- 271_feature_rows_close_failopen.sql (17.07.2026, «баги в корне и навсегда»)
-- Гейт фич fail-open: НЕТ строки плана → фича РАЗРЕШЕНА. Для новых гейтов
-- (forms, webhooks) и snake-ключей аддонов строк не было → бесплатные тарифы
-- получали платные модули даром. Закрываем явными строками:
--   enterprise, solo_max → enabled ·· остальные планы → disabled (открывается аддоном)

INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, fk.key, (p.slug IN ('enterprise', 'solo_max'))
  FROM saas_plans_v2 p
  CROSS JOIN (VALUES ('forms'), ('webhooks'), ('marketing'), ('loyalty'),
                     ('ai_receptionist'), ('ai_recommendations')) AS fk(key)
 WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro', 'enterprise', 'solo_max')
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = fk.key);
