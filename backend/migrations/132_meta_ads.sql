-- MKT-08 — Meta Ads (Facebook/Instagram реклама).
-- Підключення ad-акаунтів, кампанії + щоденна статистика, Lead Ads → CRM.
-- Живий синк через Graph API працює при наявності token зі скоупом ads_read
-- (graceful no-op без нього). Lead Ads вебхук приймається завжди.
-- Усе ізольовано по tenant_id (RLS + FORCE), як решта CRM.
-- ID — SERIAL (узгоджено з кодовою базою; client_id/branch_id = integer).

CREATE TABLE IF NOT EXISTS meta_ad_accounts (
  id                   SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id(),
  branch_id            INTEGER,
  facebook_page_id     VARCHAR(50),
  instagram_account_id VARCHAR(50),
  ad_account_id        VARCHAR(50) NOT NULL,
  pixel_id             VARCHAR(50),
  access_token_enc     TEXT,                 -- зашифрований (integration-secrets)
  token_expires_at     TIMESTAMPTZ,
  name                 VARCHAR(255),
  status               VARCHAR(20) NOT NULL DEFAULT 'active', -- active/disconnected/error
  last_synced_at       TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ad_account_id)
);

CREATE TABLE IF NOT EXISTS meta_campaigns (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  account_id       INTEGER NOT NULL REFERENCES meta_ad_accounts(id) ON DELETE CASCADE,
  meta_campaign_id VARCHAR(50) NOT NULL,
  name             VARCHAR(255),
  objective        VARCHAR(50),
  status           VARCHAR(20),             -- ACTIVE/PAUSED/ARCHIVED
  daily_budget     NUMERIC(10,2),
  lifetime_budget  NUMERIC(10,2),
  start_date       DATE,
  end_date         DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meta_campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_campaigns_acc ON meta_campaigns (tenant_id, account_id, status);

CREATE TABLE IF NOT EXISTS meta_campaign_stats (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  campaign_id INTEGER NOT NULL REFERENCES meta_campaigns(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  reach       INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  spend       NUMERIC(10,2) NOT NULL DEFAULT 0,
  leads       INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  ctr         NUMERIC(7,2),
  cpc         NUMERIC(10,2),
  cpl         NUMERIC(10,2),
  roas        NUMERIC(7,2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_stats_date ON meta_campaign_stats (tenant_id, date);

CREATE TABLE IF NOT EXISTS meta_leads (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  account_id       INTEGER REFERENCES meta_ad_accounts(id) ON DELETE SET NULL,
  meta_lead_id     VARCHAR(60) NOT NULL,
  campaign_id      INTEGER REFERENCES meta_campaigns(id) ON DELETE SET NULL,
  form_name        VARCHAR(255),
  client_name      VARCHAR(255),
  phone            VARCHAR(30),
  email            VARCHAR(255),
  service_interest VARCHAR(255),
  raw_data         JSONB,
  client_id        INTEGER,                 -- після створення клієнта
  appointment_id   INTEGER,                 -- після створення запису
  status           VARCHAR(20) NOT NULL DEFAULT 'new', -- new/contacted/booked/visited/lost
  contacted_at     TIMESTAMPTZ,
  contacted_by     INTEGER,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meta_lead_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_leads_status ON meta_leads (tenant_id, status, created_at);

-- RLS на всі 4 таблиці
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['meta_ad_accounts','meta_campaigns','meta_campaign_stats','meta_leads']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
  END LOOP;
END $$;
