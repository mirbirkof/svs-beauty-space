-- 067: FIN-02 Referral System — реферальная программа.
-- Прагматично под реальную схему: integer client/referrer/referee, BIGSERIAL id, RLS по tenant_id.
-- Легаси-таблица referrals (phone-based, используется loyalty.js) НЕ ломается:
-- добавляем новые колонки аддитивно + 4 новые таблицы. Награда — через loyalty_ledger (как везде).
BEGIN;

-- 067.1 Настройки программы (single-tenant строка на тенант)
CREATE TABLE IF NOT EXISTS referral_program_settings (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                     TEXT NOT NULL DEFAULT 'Основна програма',
  referrer_reward_type     TEXT NOT NULL DEFAULT 'bonus',   -- bonus | discount | free_service
  referrer_reward_amount   NUMERIC(10,2) NOT NULL DEFAULT 100,
  referee_reward_type      TEXT NOT NULL DEFAULT 'bonus',   -- bonus | discount
  referee_reward_amount    NUMERIC(10,2) NOT NULL DEFAULT 50,
  activation_event         TEXT NOT NULL DEFAULT 'first_paid_visit', -- first_paid_visit | registration | min_check
  min_check_amount         NUMERIC(10,2),
  attribution_window_days  INTEGER NOT NULL DEFAULT 30,
  max_rewards_per_month    INTEGER,
  max_rewards_total        INTEGER,
  mlm_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  mlm_levels               INTEGER NOT NULL DEFAULT 2,
  mlm_l2_percent           NUMERIC(5,2) NOT NULL DEFAULT 30.00,
  mlm_l3_percent           NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 067.2 Реферальные коды клиентов
CREATE TABLE IF NOT EXISTS referral_codes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id       INTEGER NOT NULL,
  code            TEXT NOT NULL,
  short_path      TEXT,                         -- /r/SVS-A1B2 (хост подставляет фронт)
  campaign_id     INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  total_clicks    INTEGER NOT NULL DEFAULT 0,
  total_referrals INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_refcodes_client ON referral_codes (tenant_id, client_id);

-- 067.3 Расширение легаси-таблицы referrals (аддитивно, без ломки phone-based кода loyalty.js)
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_id        INTEGER;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referee_id         INTEGER;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referral_code_id   BIGINT REFERENCES referral_codes(id) ON DELETE SET NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS level              INTEGER NOT NULL DEFAULT 1;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS parent_referral_id INTEGER;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status             TEXT NOT NULL DEFAULT 'pending'; -- pending|qualified|rewarded|rejected|under_review
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS click_at           TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS registered_at      TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS first_visit_at     TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualified_at       TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rewarded_at        TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rejection_reason   TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS fraud_flags        JSONB;
-- один реферер на нового клиента (только для строк нового движка, где referee_id задан)
CREATE UNIQUE INDEX IF NOT EXISTS ux_referrals_referee ON referrals (tenant_id, referee_id) WHERE referee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_referrals_referrer ON referrals (tenant_id, referrer_id, status);
CREATE INDEX IF NOT EXISTS ix_referrals_status ON referrals (tenant_id, status, created_at DESC);

-- 067.4 Вознаграждения
CREATE TABLE IF NOT EXISTS referral_rewards (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  referral_id    INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  recipient_id   INTEGER NOT NULL,
  recipient_role TEXT NOT NULL,                 -- referrer | referee
  reward_type    TEXT NOT NULL,                 -- bonus | discount | free_service
  reward_amount  NUMERIC(10,2) NOT NULL,
  level          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | issued | failed | cancelled
  ledger_id      INTEGER,                       -- ссылка на loyalty_ledger.id (если bonus)
  issued_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_refrewards_recipient ON referral_rewards (tenant_id, recipient_id);
CREATE INDEX IF NOT EXISTS ix_refrewards_referral ON referral_rewards (referral_id);

-- 067.5 Клики по реферальным ссылкам
CREATE TABLE IF NOT EXISTS referral_clicks (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  referral_code_id   BIGINT NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  ip_address         TEXT,
  user_agent         TEXT,
  device_fingerprint TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  converted          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_refclicks_code ON referral_clicks (referral_code_id, created_at DESC);

-- RLS на новых таблицах
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['referral_program_settings','referral_codes','referral_rewards','referral_clicks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_program_settings, referral_codes, referral_rewards, referral_clicks TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE referral_program_settings_id_seq, referral_codes_id_seq, referral_rewards_id_seq, referral_clicks_id_seq TO app_tenant;

COMMIT;
