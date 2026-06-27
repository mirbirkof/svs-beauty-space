-- 151: MKT-05 Referral Marketing / Реферальный маркетинг
-- Маркетинговая надстройка над FIN-02 (referral_codes/referral_clicks/referrals):
-- лендинги реферальной программы, промоматериалы, геймификация (лидерборд+уровни), аналитика.
-- Данные о кликах/конверсиях/наградах берутся из FIN-02 (067) — здесь только маркетинговый слой.
-- Схема следует кодовой базе: integer client_id, tenant_id UUID + RLS, как в 149.
BEGIN;

-- ─── 151.1 Программы реферального маркетинга (лендинги) ───────────────────────
CREATE TABLE IF NOT EXISTS referral_marketing_programs (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id                   INTEGER,                       -- NULL = все филиалы
  name                        VARCHAR(255) NOT NULL,
  landing_slug                VARCHAR(60)  NOT NULL,
  landing_html                TEXT,                          -- кастомный HTML лендинга (если NULL — дефолтный рендер)
  referrer_reward_description TEXT,
  friend_reward_description   TEXT,
  hero_title                  VARCHAR(255),
  hero_subtitle               TEXT,
  cta_text                    VARCHAR(120) NOT NULL DEFAULT 'Записатися зі знижкою',
  theme                       VARCHAR(20)  NOT NULL DEFAULT 'default', -- для A/B дизайнов
  active                      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refmkt_programs_slug ON referral_marketing_programs (tenant_id, landing_slug);
CREATE INDEX IF NOT EXISTS ix_refmkt_programs_active ON referral_marketing_programs (tenant_id, active);

-- ─── 151.2 Промоматериалы ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_marketing_materials (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  program_id  UUID         REFERENCES referral_marketing_programs(id) ON DELETE CASCADE,
  type        VARCHAR(20)  NOT NULL CHECK (type IN ('text','banner','story','flyer','card')),
  title       VARCHAR(255),
  content     TEXT,                          -- текст для шаринга или HTML (поддерживает {name}/{code}/{discount})
  image_url   VARCHAR(500),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_refmkt_materials_program ON referral_marketing_materials (tenant_id, program_id, active);

-- ─── 151.3 Лидерборд (снапшот по периодам) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_marketing_leaderboard (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id            INTEGER      NOT NULL,
  period               VARCHAR(7)   NOT NULL,            -- '2026-06'
  referrals_count      INTEGER      NOT NULL DEFAULT 0,
  referrals_converted  INTEGER      NOT NULL DEFAULT 0,
  total_reward         DECIMAL(10,2) NOT NULL DEFAULT 0,
  rank                 INTEGER,
  level                VARCHAR(20)  NOT NULL DEFAULT 'bronze' CHECK (level IN ('bronze','silver','gold','platinum')),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refmkt_leaderboard ON referral_marketing_leaderboard (tenant_id, client_id, period);
CREATE INDEX IF NOT EXISTS ix_refmkt_leaderboard_period ON referral_marketing_leaderboard (tenant_id, period, rank);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'referral_marketing_programs',
    'referral_marketing_materials',
    'referral_marketing_leaderboard'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
        WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  referral_marketing_programs,
  referral_marketing_materials,
  referral_marketing_leaderboard
TO app_tenant;

COMMIT;
