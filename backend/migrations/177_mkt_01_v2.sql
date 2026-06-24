-- 177: MKT-01 v2 — добиваем Marketing Center до спеки.
-- Существующее (миграция 068: marketing_activities / marketing_channel_spend / marketing_goals)
-- НЕ трогаем. Добавляем недостающие сущности спеки:
--   utm_tracking         — мульти-touch UTM-касания клиента (для атрибуции и отчётов);
--   attribution_data     — рассчитанная атрибуция конверсий по 5 моделям;
--   marketing_budget     — план/факт/committed бюджет по каналам с workflow утверждения;
--   marketing_insights   — персистентные инсайты/рекомендации со статусом.
-- Стиль — как 068/151: tenant_id DEFAULT current_tenant_id(), RLS FORCE, GRANT app_tenant.
-- Всё через IF NOT EXISTS — миграция идемпотентна.
BEGIN;

-- ── 177.1 UTM-касания (multi-touch) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS utm_tracking (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id           INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,
  utm_term            TEXT,
  utm_content         TEXT,
  full_url            TEXT,
  landing_page        TEXT,
  referrer            TEXT,
  ip_address          INET,
  user_agent          TEXT,
  device_type         TEXT,                            -- desktop|mobile|tablet
  touch_number        INTEGER NOT NULL DEFAULT 1,
  is_converting_touch BOOLEAN NOT NULL DEFAULT FALSE,
  touch_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_utm_client  ON utm_tracking (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS ix_utm_source  ON utm_tracking (tenant_id, utm_source, utm_campaign);

-- ── 177.2 Рассчитанная атрибуция конверсий ───────────────────────────────────
CREATE TABLE IF NOT EXISTS attribution_data (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id                INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  conversion_type          TEXT NOT NULL,              -- first_visit|repeat_visit|purchase
  conversion_id            INTEGER,
  conversion_value         NUMERIC(12,2) DEFAULT 0,
  conversion_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  touches                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  attribution_first_touch  JSONB,
  attribution_last_touch   JSONB,
  attribution_linear       JSONB,
  attribution_time_decay   JSONB,
  attribution_position     JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_attr_client ON attribution_data (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS ix_attr_conv   ON attribution_data (tenant_id, conversion_at DESC);

-- ── 177.3 Бюджет маркетинга (план/факт/committed + workflow) ──────────────────
CREATE TABLE IF NOT EXISTS marketing_budget (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  period_type      TEXT NOT NULL DEFAULT 'month',      -- month|quarter|year
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  channel          TEXT NOT NULL,                      -- telegram|sms|email|viber|google_ads|meta_ads|instagram|referral|offline|other
  budget_planned   NUMERIC(12,2) NOT NULL DEFAULT 0,
  budget_spent     NUMERIC(12,2) NOT NULL DEFAULT 0,
  budget_committed NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'draft',      -- draft|approved|closed
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_start, channel)
);
CREATE INDEX IF NOT EXISTS ix_mkt_budget_period ON marketing_budget (tenant_id, period_start, channel);

-- ── 177.4 Инсайты / рекомендации (персистентные, со статусом) ─────────────────
CREATE TABLE IF NOT EXISTS marketing_insights (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  type             TEXT NOT NULL,                      -- budget|channel|retention|timing|campaign|referral
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  data             JSONB,
  suggested_action TEXT,
  action_module    TEXT,                               -- MKT-03|MKT-04|...
  action_params    JSONB,
  priority         INTEGER NOT NULL DEFAULT 0,         -- 0=low 1=medium 2=high
  status           TEXT NOT NULL DEFAULT 'new',        -- new|accepted|rejected|dismissed
  dedup_key        TEXT,                               -- идемпотентность авто-генерации
  valid_until      DATE,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS ix_mkt_insights_status ON marketing_insights (tenant_id, status, priority DESC);

-- ── 177.5 RLS + GRANT (как в 068/151) ────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['utm_tracking','attribution_data','marketing_budget','marketing_insights'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON utm_tracking, attribution_data, marketing_budget, marketing_insights TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE utm_tracking_id_seq, attribution_data_id_seq, marketing_budget_id_seq, marketing_insights_id_seq TO app_tenant;

COMMIT;
