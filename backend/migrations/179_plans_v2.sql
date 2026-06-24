-- Migration 179: SAS-04 Plans & Pricing v2
-- Каталог тарифних планів продукту (free/starter/professional/enterprise),
-- feature gates, лімітів, add-ons, історії зміни плану.
--
-- ПРИМІТКА: легасі-таблиця saas_plans (BIGSERIAL id / code PK, features+limits JSONB
-- з міграції 095) НЕ чіпається. Цей модуль додає НОВУ v2-лінійку (UUID-схема зі
-- спеки SAS-04) під іменем saas_plans_v2 + нормалізовані plan_features/plan_limits.
-- Тільки нове, ідемпотентно (IF NOT EXISTS).

BEGIN;

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE plan_status_enum AS ENUM ('draft','published','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE addon_type_enum AS ENUM ('limit_boost','feature_unlock','one_time');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE plan_change_action_enum AS ENUM (
    'created','upgraded','downgraded','renewed','trial_started','cancelled','price_versioned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── saas_plans_v2 (Plan Catalog) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_plans_v2 (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(100)  NOT NULL,
  slug                VARCHAR(50)   UNIQUE NOT NULL,        -- free|starter|professional|enterprise|custom_*
  description         TEXT,
  tier                SMALLINT      NOT NULL DEFAULT 0,     -- 0=free 1=starter 2=professional 3=enterprise 9=custom
  price_monthly_uah   NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_yearly_uah    NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_monthly_usd   NUMERIC(10,2) DEFAULT 0,
  price_yearly_usd    NUMERIC(10,2) DEFAULT 0,
  price_monthly_eur   NUMERIC(10,2) DEFAULT 0,
  price_yearly_eur    NUMERIC(10,2) DEFAULT 0,
  trial_days          INT           NOT NULL DEFAULT 14,
  status              plan_status_enum NOT NULL DEFAULT 'published',
  is_public           BOOLEAN       NOT NULL DEFAULT true,
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  is_popular          BOOLEAN       NOT NULL DEFAULT false,  -- highlight "Популярний вибір"
  contact_sales       BOOLEAN       NOT NULL DEFAULT false,  -- enterprise: "Зв'язатися з нами"
  sort_order          INT           NOT NULL DEFAULT 0,
  version             INT           NOT NULL DEFAULT 1,
  superseded_by       UUID          REFERENCES saas_plans_v2(id) ON DELETE SET NULL, -- legacy → new version
  metadata            JSONB         NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plans_v2_active ON saas_plans_v2 (is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_plans_v2_public ON saas_plans_v2 (is_public, status);
CREATE INDEX IF NOT EXISTS idx_plans_v2_tier   ON saas_plans_v2 (tier);

-- ── plan_features (Feature Gates) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_features (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID          NOT NULL REFERENCES saas_plans_v2(id) ON DELETE CASCADE,
  feature_key VARCHAR(100)  NOT NULL,    -- calendar.online_booking, mkt.campaigns, ai.recommendations
  enabled     BOOLEAN       NOT NULL DEFAULT false,
  metadata    JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_pf_feature ON plan_features (feature_key);
CREATE INDEX IF NOT EXISTS idx_pf_plan    ON plan_features (plan_id);

-- ── plan_limits (Limits Definition) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_limits (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID         NOT NULL REFERENCES saas_plans_v2(id) ON DELETE CASCADE,
  limit_key   VARCHAR(50)  NOT NULL,    -- max_employees|max_clients|max_storage_mb|max_sms_month|max_api_calls_hour|max_branches|max_services
  limit_value INT          NOT NULL,    -- -1 = unlimited
  is_soft     BOOLEAN      NOT NULL DEFAULT false,  -- soft=попередження, hard=блокування
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (plan_id, limit_key)
);
CREATE INDEX IF NOT EXISTS idx_pl_plan ON plan_limits (plan_id);

-- ── plan_addons (Add-ons Manager) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_addons (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR(100)  NOT NULL,
  slug               VARCHAR(50)   UNIQUE NOT NULL,
  description        TEXT,
  addon_type         addon_type_enum NOT NULL,
  limit_key          VARCHAR(50),         -- якщо limit_boost
  limit_boost_value  INT,
  feature_key        VARCHAR(100),        -- якщо feature_unlock
  price_monthly_uah  NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_yearly_uah   NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_one_time_uah NUMERIC(10,2) DEFAULT 0,
  compatible_plans   UUID[]        NOT NULL DEFAULT '{}',   -- пустий = сумісний з усіма
  is_active          BOOLEAN       NOT NULL DEFAULT true,
  is_public          BOOLEAN       NOT NULL DEFAULT true,
  sort_order         INT           NOT NULL DEFAULT 0,
  metadata           JSONB         NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paddons_active ON plan_addons (is_active, sort_order);

-- ── tenant_plan_addons (підключені add-ons тенанта) ────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_plan_addons (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL,
  addon_id    UUID         NOT NULL REFERENCES plan_addons(id) ON DELETE CASCADE,
  cycle       VARCHAR(10)  NOT NULL DEFAULT 'monthly',  -- monthly|yearly|one_time
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',   -- active|pending|cancelled
  price_uah   NUMERIC(10,2) NOT NULL DEFAULT 0,
  invoice_ref VARCHAR(100),
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancel_at   TIMESTAMPTZ,                              -- відключення в кінці періоду
  cancelled_at TIMESTAMPTZ,
  metadata    JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tpa_tenant_addon_active
  ON tenant_plan_addons (tenant_id, addon_id) WHERE status IN ('active','pending');
CREATE INDEX IF NOT EXISTS idx_tpa_tenant ON tenant_plan_addons (tenant_id);

-- ── plan_change_log (історія зміни плану тенанта) ──────────────────────────────
CREATE TABLE IF NOT EXISTS plan_change_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  action        plan_change_action_enum NOT NULL,
  from_plan_id  UUID        REFERENCES saas_plans_v2(id) ON DELETE SET NULL,
  to_plan_id    UUID        REFERENCES saas_plans_v2(id) ON DELETE SET NULL,
  prorated_uah  NUMERIC(10,2) DEFAULT 0,
  actor_id      UUID,
  actor_type    VARCHAR(20) NOT NULL DEFAULT 'system',
  details       JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcl_tenant ON plan_change_log (tenant_id, created_at DESC);

-- ── Seed: базова лінійка тарифів ───────────────────────────────────────────────
INSERT INTO saas_plans_v2 (slug, name, description, tier, price_monthly_uah, price_yearly_uah, price_monthly_usd, price_yearly_usd, price_monthly_eur, price_yearly_eur, trial_days, is_popular, contact_sales, sort_order) VALUES
  ('free',         'Free',         'Старт для майстра-одинака',                 0,    0,     0,     0,    0,     0,    0,    14, false, false, 10),
  ('starter',      'Starter',      'Малий салон: базова автоматизація',         1,  490,  4900,    13,  130,    12,  120,   14, false, false, 20),
  ('professional', 'Professional', 'Зростаючий салон: маркетинг + AI',          2,  990,  9900,    26,  260,    24,  240,   14, true,  false, 30),
  ('enterprise',   'Enterprise',   'Мережа салонів: усе включено + кастом',     3, 2990, 29900,    79,  790,    74,  740,   30, false, true,  40)
ON CONFLICT (slug) DO NOTHING;

-- Feature gates по планах
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, f.feature_key, f.enabled
FROM saas_plans_v2 p
JOIN (VALUES
  -- free
  ('free','calendar.online_booking',          true),
  ('free','clients.crm',                       true),
  ('free','mkt.campaigns',                     false),
  ('free','ai.recommendations',                false),
  ('free','ai.receptionist',                   false),
  ('free','loyalty.program',                   false),
  ('free','api.public',                        false),
  ('free','analytics.advanced',                false),
  -- starter
  ('starter','calendar.online_booking',        true),
  ('starter','clients.crm',                    true),
  ('starter','mkt.campaigns',                  true),
  ('starter','loyalty.program',                true),
  ('starter','ai.recommendations',             false),
  ('starter','ai.receptionist',                false),
  ('starter','api.public',                     false),
  ('starter','analytics.advanced',             false),
  -- professional
  ('professional','calendar.online_booking',   true),
  ('professional','clients.crm',               true),
  ('professional','mkt.campaigns',             true),
  ('professional','loyalty.program',           true),
  ('professional','ai.recommendations',        true),
  ('professional','ai.receptionist',           true),
  ('professional','api.public',                true),
  ('professional','analytics.advanced',        true),
  -- enterprise (усе)
  ('enterprise','calendar.online_booking',     true),
  ('enterprise','clients.crm',                 true),
  ('enterprise','mkt.campaigns',               true),
  ('enterprise','loyalty.program',             true),
  ('enterprise','ai.recommendations',          true),
  ('enterprise','ai.receptionist',             true),
  ('enterprise','api.public',                  true),
  ('enterprise','analytics.advanced',          true)
) AS f(slug, feature_key, enabled) ON f.slug = p.slug
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Limits по планах (-1 = безліміт)
INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, l.limit_key, l.limit_value, l.is_soft
FROM saas_plans_v2 p
JOIN (VALUES
  -- free
  ('free','max_employees',         3, false),
  ('free','max_clients',         500, false),
  ('free','max_storage_mb',     1024, false),
  ('free','max_sms_month',         0, false),
  ('free','max_api_calls_hour',    0, false),
  ('free','max_branches',          1, false),
  ('free','max_services',         30, true),
  -- starter
  ('starter','max_employees',     10, false),
  ('starter','max_clients',     3000, false),
  ('starter','max_storage_mb',  5120, false),
  ('starter','max_sms_month',    500, true),
  ('starter','max_api_calls_hour', 0, false),
  ('starter','max_branches',       2, false),
  ('starter','max_services',     100, true),
  -- professional
  ('professional','max_employees',     30, false),
  ('professional','max_clients',     15000, false),
  ('professional','max_storage_mb',  20480, false),
  ('professional','max_sms_month',    2000, true),
  ('professional','max_api_calls_hour', 1000, true),
  ('professional','max_branches',        5, false),
  ('professional','max_services',      500, true),
  -- enterprise
  ('enterprise','max_employees',       -1, false),
  ('enterprise','max_clients',         -1, false),
  ('enterprise','max_storage_mb',      -1, false),
  ('enterprise','max_sms_month',       -1, false),
  ('enterprise','max_api_calls_hour',  -1, false),
  ('enterprise','max_branches',        -1, false),
  ('enterprise','max_services',        -1, false)
) AS l(slug, limit_key, limit_value, is_soft) ON l.slug = p.slug
ON CONFLICT (plan_id, limit_key) DO NOTHING;

-- Базові add-ons
INSERT INTO plan_addons (slug, name, description, addon_type, limit_key, limit_boost_value, feature_key, price_monthly_uah, price_yearly_uah, price_one_time_uah, sort_order) VALUES
  ('sms_1000',      '+1000 SMS',          'Додатковий пакет 1000 SMS на місяць',   'limit_boost',   'max_sms_month',    1000, NULL,                   149,  1490,    0, 10),
  ('storage_10gb',  '+10 ГБ сховища',     'Додаткові 10 ГБ для фото та документів','limit_boost',   'max_storage_mb',  10240, NULL,                    99,   990,    0, 20),
  ('extra_branch',  'Додатковий філіал',  '+1 філіал до ліміту плану',             'limit_boost',   'max_branches',        1, NULL,                   299,  2990,    0, 30),
  ('ai_module',     'AI-модуль',          'Розблокувати AI-рекомендації та рецепціоніста','feature_unlock', NULL,        NULL, 'ai.recommendations',  399,  3990,    0, 40)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
