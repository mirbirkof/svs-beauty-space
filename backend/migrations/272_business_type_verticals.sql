-- 272_business_type_verticals.sql (18.07.2026, Jarvis)
-- Вертикали платформы: beauty (текущая), fitness, dental. Приказ Босса 18.07.
-- Все существующие тенанты остаются beauty — поведение салона не меняется ни на байт.
-- Изоляция: модули вертикалей живут в своих таблицах (fitness_*, dental_*) и роутах,
-- доступ только при совпадении tenants.business_type (requireVertical → 404 чужим).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_type TEXT NOT NULL DEFAULT 'beauty';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_business_type_chk') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_business_type_chk
      CHECK (business_type IN ('beauty', 'fitness', 'dental'));
  END IF;
END $$;

-- Фиче-ключи вертикалей в тарифы (паттерн миграции 271 — явные строки, без fail-open).
-- Базовые операции вертикали доступны на всех планах (иначе fitness/dental на free мертвы):
--   fitness.memberships, fitness.classes, dental.chart, dental.medical
-- Премиум (enterprise/solo_max, остальным — через аддон):
--   fitness.checkin, dental.plans, dental.lab
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, fk.key, TRUE
  FROM saas_plans_v2 p
  CROSS JOIN (VALUES ('fitness.memberships'), ('fitness.classes'),
                     ('dental.chart'), ('dental.medical')) AS fk(key)
 WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro', 'enterprise', 'solo_max')
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = fk.key);

INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, fk.key, (p.slug IN ('enterprise', 'solo_max'))
  FROM saas_plans_v2 p
  CROSS JOIN (VALUES ('fitness.checkin'), ('dental.plans'), ('dental.lab')) AS fk(key)
 WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro', 'enterprise', 'solo_max')
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = fk.key);
