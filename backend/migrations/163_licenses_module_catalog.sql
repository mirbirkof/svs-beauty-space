-- Migration 163: SAS-05 Module Catalog + Licenses lifecycle
-- module_catalog, licenses, license_activations, license_keys

BEGIN;

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE module_status_enum   AS ENUM ('available','coming_soon','deprecated','hidden');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE license_type_enum    AS ENUM ('trial','subscription','perpetual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE license_status_enum  AS ENUM ('active','expired','suspended','revoked','grace_period');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE activation_action_enum AS ENUM (
    'activated','deactivated','renewed','expired','revoked',
    'trial_started','trial_converted','grace_started','grace_ended','key_generated','key_revoked'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── module_catalog ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module_catalog (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                VARCHAR(40) UNIQUE NOT NULL,
  name                VARCHAR(100) NOT NULL,
  description         TEXT,
  category            VARCHAR(30)  NOT NULL DEFAULT 'crm',
  icon_url            VARCHAR(500),
  dependencies        UUID[]       NOT NULL DEFAULT '{}',
  min_plan_tier       SMALLINT     NOT NULL DEFAULT 0,
  price_monthly_uah   NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_yearly_uah    NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_perpetual_uah NUMERIC(10,2) DEFAULT 0,
  trial_days          INT          NOT NULL DEFAULT 14,
  status              module_status_enum NOT NULL DEFAULT 'available',
  sort_order          INT          NOT NULL DEFAULT 0,
  metadata            JSONB        NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mc_category ON module_catalog (category, sort_order);

-- ── licenses ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL,
  module_id         UUID         NOT NULL REFERENCES module_catalog(id) ON DELETE RESTRICT,
  license_type      license_type_enum  NOT NULL,
  status            license_status_enum NOT NULL DEFAULT 'active',
  activated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  grace_period_ends TIMESTAMPTZ,
  renewed_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     VARCHAR(255),
  subscription_ref  VARCHAR(100),
  metadata          JSONB        NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lic_tenant_module_active
  ON licenses (tenant_id, module_id)
  WHERE status IN ('active','grace_period');
CREATE INDEX IF NOT EXISTS idx_lic_tenant   ON licenses (tenant_id);
CREATE INDEX IF NOT EXISTS idx_lic_expires  ON licenses (expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lic_module   ON licenses (module_id);

-- ── license_activations (audit log) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_activations (
  id          UUID       PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id  UUID       NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  action      activation_action_enum NOT NULL,
  actor_id    UUID,
  actor_type  VARCHAR(20) NOT NULL DEFAULT 'system',
  details     JSONB       NOT NULL DEFAULT '{}',
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_la_license ON license_activations (license_id, created_at DESC);

-- ── license_keys (on-premise JWT keys) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_keys (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL,
  key_hash             VARCHAR(64) UNIQUE NOT NULL,
  jwt_payload          JSONB       NOT NULL DEFAULT '{}',
  hardware_fingerprint VARCHAR(64),
  is_revoked           BOOLEAN     NOT NULL DEFAULT false,
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  last_verified_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lk_tenant  ON license_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_lk_revoked ON license_keys (is_revoked) WHERE is_revoked = true;

-- ── Seed: базовий каталог модулів платформи ───────────────────────────────────
INSERT INTO module_catalog (code, name, description, category, min_plan_tier, price_monthly_uah, price_yearly_uah, trial_days, sort_order, status) VALUES
  ('crm_card',            'CRM Картка клієнта 360°',      'Повна картка: таймлайн, фінанси, переваги, нотатки', 'crm',          0, 0,    0,    0,  10, 'available'),
  ('visit_pipeline',      'Воронка відвідувань',           'Kanban-стадії запису з SLA та тригерами',            'crm',          1, 299,  2990, 14, 20, 'available'),
  ('employees_hr',        'HR Співробітники',              'Кадровий облік, документи, спеціалізації',           'crm',          1, 499,  4990, 14, 30, 'available'),
  ('rooms',               'Кімнати та кабінети',           'Розклад кімнат, обладнання, блокування',             'crm',          1, 299,  2990, 14, 40, 'available'),
  ('shifts',              'Графіки та зміни',              'Шаблони ротацій, обмін змінами, табель',             'crm',          1, 399,  3990, 14, 50, 'available'),
  ('mkt_referral',        'Реферальний маркетинг',         'Програми, лідерборд, персоналізація',                'marketing',    2, 599,  5990, 14, 60, 'available'),
  ('mkt_campaigns',       'Маркетингові кампанії',         'SMS/Email/Push кампанії з аналітикою',               'marketing',    2, 699,  6990, 14, 70, 'available'),
  ('mkt_segmentation',    'Сегментація клієнтів',          'RFM, кастомні сегменти, авто-теги',                  'marketing',    2, 499,  4990, 14, 80, 'available'),
  ('ai_recommendations',  'AI Рекомендації послуг',        'Гібридна CF+CB система рекомендацій',                'ai',           2, 799,  7990, 30, 90, 'available'),
  ('ai_receptionist',     'AI Рецепціоніст',               'Автовідповіді, запис через бота',                    'ai',           2, 999,  9990, 30,100, 'available'),
  ('ai_forecasting',      'AI Прогнозування',              'Завантаження, дохід, відтік клієнтів',               'ai',           3,1299, 12990, 30,110, 'available'),
  ('fin_budgeting',       'Бюджетування',                  'Планування, виконання, відхилення',                  'finance',      2, 599,  5990, 14,120, 'available'),
  ('fin_kpi',             'KPI співробітників',            'Метрики, цілі, бонуси, лідерборд',                   'finance',      2, 699,  6990, 14,130, 'available'),
  ('fin_kpi_branches',    'KPI філіалів',                  'Рейтинг філіалів, порівняння, бонуси',               'finance',      3, 799,  7990, 14,140, 'available'),
  ('inf_event_bus',       'Event Bus',                     'Реєстр подій, DLQ, replay, підписки',                'infrastructure',3, 499,  4990, 14,150, 'available'),
  ('omnichannel',         'Омніканальні комунікації',      'Чати, оператори, SLA, CSAT',                         'integration',  2, 699,  6990, 14,160, 'available'),
  ('before_after',        'Фото До/Після',                 'Портфоліо, модерація, згоди клієнтів',               'crm',          1, 299,  2990, 14,170, 'available'),
  ('procedure_materials', 'Витратні матеріали',            'Норми, списання, собівартість процедур',              'crm',          1, 399,  3990, 14,180, 'available'),
  ('sas_saas_analytics',  'SaaS Аналітика',               'MRR, churn, NPS, когортний аналіз',                  'infrastructure',3, 999,  9990, 30,190, 'available'),
  ('sas_tenant_mgmt',     'Управління тенантами',          'Реєстр салонів, onboarding, метрики',                'infrastructure',3, 699,  6990, 14,200, 'available')
ON CONFLICT (code) DO NOTHING;

COMMIT;
