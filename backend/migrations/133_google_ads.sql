-- MKT-09 — Google Ads (пошукова/медійна реклама Google).
-- Підключення Google Ads акаунтів, кампанії + щоденна статистика,
-- gclid-трекінг та offline-конверсії (запис/візит → завантаження в Google Ads).
-- Живий синк/upload через Google Ads API працює при наявності developer-token
-- + OAuth refresh_token (graceful no-op без них). gclid ловиться при бронюванні завжди.
-- Усе ізольовано по tenant_id (RLS + FORCE). ID — SERIAL (узгоджено з кодовою базою).

CREATE TABLE IF NOT EXISTS google_ads_accounts (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  branch_id        INTEGER,
  customer_id      VARCHAR(20) NOT NULL,      -- Google Ads Customer ID (10 цифр)
  ga4_property_id  VARCHAR(20),
  access_token_enc TEXT,                      -- зашифрований
  refresh_token_enc TEXT,                     -- зашифрований (для авто-refresh)
  name             VARCHAR(255),
  status           VARCHAR(20) NOT NULL DEFAULT 'active', -- active/disconnected/error
  last_synced_at   TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id)
);

CREATE TABLE IF NOT EXISTS google_ads_campaigns (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id(),
  account_id         INTEGER NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  google_campaign_id VARCHAR(50) NOT NULL,
  name               VARCHAR(255),
  type               VARCHAR(30),             -- SEARCH/DISPLAY/PMAX/LOCAL
  status             VARCHAR(20),             -- ENABLED/PAUSED/REMOVED
  daily_budget       NUMERIC(10,2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, google_campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_gads_campaigns_acc ON google_ads_campaigns (tenant_id, account_id, status);

CREATE TABLE IF NOT EXISTS google_ads_stats (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  campaign_id      INTEGER NOT NULL REFERENCES google_ads_campaigns(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  impressions      INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  spend            NUMERIC(10,2) NOT NULL DEFAULT 0,
  conversions      INTEGER NOT NULL DEFAULT 0,
  conversion_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  ctr              NUMERIC(7,2),
  cpc              NUMERIC(10,2),
  roas             NUMERIC(7,2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, date)
);
CREATE INDEX IF NOT EXISTS idx_gads_stats_date ON google_ads_stats (tenant_id, date);

CREATE TABLE IF NOT EXISTS google_ads_conversions (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id(),
  account_id         INTEGER REFERENCES google_ads_accounts(id) ON DELETE SET NULL,
  gclid              VARCHAR(255),
  client_id          INTEGER,
  appointment_id     INTEGER,
  conversion_type    VARCHAR(30) NOT NULL DEFAULT 'booking', -- booking/visit/purchase
  conversion_value   NUMERIC(10,2),
  conversion_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_to_google BOOLEAN NOT NULL DEFAULT false,
  uploaded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gads_conv_gclid ON google_ads_conversions (tenant_id, gclid);
CREATE INDEX IF NOT EXISTS idx_gads_conv_pending ON google_ads_conversions (tenant_id, uploaded_to_google);

-- RLS на всі 4 таблиці
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_ads_accounts','google_ads_campaigns','google_ads_stats','google_ads_conversions']
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
