-- 068: MKT-01 Marketing Center — агрегуючий центр маркетингу.
-- Дашборд/воронка/канали/когорти/інсайти рахуються на льоту з існуючих даних (clients.source,
-- campaigns, referrals, cash_operations) — НОВИХ важких таблиць не треба. Додаємо лише:
-- календар активностей, ручні витрати по каналах (offline), маркетинг-цілі.
BEGIN;

CREATE TABLE IF NOT EXISTS marketing_activities (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  title         TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'campaign', -- campaign|promotion|holiday|seasonal|event|reminder
  channels      TEXT[],
  start_date    DATE NOT NULL,
  end_date      DATE,
  budget        NUMERIC(12,2) NOT NULL DEFAULT 0,
  owner_name    TEXT,
  campaign_id   INTEGER,
  promo_id      INTEGER,
  recurrence    TEXT,                            -- yearly|monthly|null
  color         TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'planned', -- planned|active|done|cancelled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mkt_act_dates ON marketing_activities (tenant_id, start_date);

CREATE TABLE IF NOT EXISTS marketing_channel_spend (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  channel       TEXT NOT NULL,                   -- telegram|sms|email|viber|google_ads|meta_ads|instagram|referral|offline|other
  period_month  DATE NOT NULL,                   -- перше число місяця
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, channel, period_month)
);

CREATE TABLE IF NOT EXISTS marketing_goals (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  period_month  DATE NOT NULL,
  metric        TEXT NOT NULL,                   -- new_clients|revenue|cac|roi|retention
  target_value  NUMERIC(14,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_month, metric)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_activities','marketing_channel_spend','marketing_goals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_activities, marketing_channel_spend, marketing_goals TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE marketing_activities_id_seq, marketing_channel_spend_id_seq, marketing_goals_id_seq TO app_tenant;

COMMIT;
