-- 116: Закрытие 5 отложенных модулей до 11/11 фаз.
--   MKT-07 Google Business · FIN-10 KPI Branches · INF-06 Backup ·
--   INF-07 Data Warehouse · INT-04 Marketplace.
-- Прагматично под 1 салон / SaaS-ядро: хранение + API, без внешних вендорских
-- зависимостей в БД. RLS-изоляция по эталону 115. tenant_id = current_tenant_id().

-- ════════════════════ MKT-07 GOOGLE BUSINESS ════════════════════
CREATE TABLE IF NOT EXISTS gbp_profile (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  location_id     TEXT,                       -- Google location id (accounts/x/locations/y)
  name            TEXT,
  address         TEXT,
  phone           TEXT,
  website         TEXT,
  categories      JSONB NOT NULL DEFAULT '[]',
  hours           JSONB NOT NULL DEFAULT '{}',  -- {mon:[..],..}
  attributes      JSONB NOT NULL DEFAULT '{}',  -- wifi/parking/accessibility...
  description     TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'not_connected', -- not_connected|connected|error
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_gbp_profile_tenant ON gbp_profile (tenant_id);

CREATE TABLE IF NOT EXISTS gbp_posts (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  post_type     TEXT NOT NULL DEFAULT 'update', -- update|offer|event
  title         TEXT,
  body          TEXT,
  cta_type      TEXT,                           -- BOOK|ORDER|LEARN_MORE|CALL...
  cta_url       TEXT,
  media_url     TEXT,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|published|expired
  published_at  TIMESTAMPTZ,
  views         INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_gbp_posts_tenant ON gbp_posts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gbp_qna (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  question      TEXT NOT NULL,
  asked_by      TEXT,
  answer        TEXT,
  answered_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|answered
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_gbp_qna_tenant ON gbp_qna (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gbp_metrics (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  metric_date   DATE NOT NULL,
  impressions   INTEGER NOT NULL DEFAULT 0,     -- показы в Search/Maps
  searches      INTEGER NOT NULL DEFAULT 0,
  website_clicks INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  directions    INTEGER NOT NULL DEFAULT 0,     -- маршруты
  bookings      INTEGER NOT NULL DEFAULT 0,
  local_pack_pos INTEGER,                       -- позиция в Local Pack
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, metric_date)
);
CREATE INDEX IF NOT EXISTS ix_gbp_metrics_tenant ON gbp_metrics (tenant_id, metric_date DESC);

-- ════════════════════ FIN-10 KPI BRANCHES ════════════════════
-- Метрики считаются вживую из appointments/branches (см. routes/kpi-branches.js).
-- Здесь — только план (target) по филиалу для план vs факт.
CREATE TABLE IF NOT EXISTS fin_branch_targets (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id     INTEGER,
  period_month  TEXT NOT NULL,                  -- 'YYYY-MM'
  revenue_target NUMERIC(14,2) NOT NULL DEFAULT 0,
  visits_target INTEGER NOT NULL DEFAULT 0,
  new_clients_target INTEGER NOT NULL DEFAULT 0,
  occupancy_target NUMERIC(5,2) NOT NULL DEFAULT 0, -- % загрузки
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, branch_id, period_month)
);
CREATE INDEX IF NOT EXISTS ix_fin_branch_targets_tenant ON fin_branch_targets (tenant_id, period_month);

-- ════════════════════ INF-06 BACKUP & RECOVERY ════════════════════
CREATE TABLE IF NOT EXISTS backup_config (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  schedule        TEXT NOT NULL DEFAULT 'daily',  -- daily|weekly|off
  retention_days  INTEGER NOT NULL DEFAULT 30,
  encrypt         BOOLEAN NOT NULL DEFAULT TRUE,
  geo_regions     JSONB NOT NULL DEFAULT '["eu-central","eu-west"]',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  backup_type   TEXT NOT NULL DEFAULT 'full',   -- full|incremental|differential
  status        TEXT NOT NULL DEFAULT 'running',-- running|success|failed
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  tables_count  INTEGER NOT NULL DEFAULT 0,
  rows_count    BIGINT NOT NULL DEFAULT 0,
  region        TEXT,
  encrypted     BOOLEAN NOT NULL DEFAULT TRUE,
  checksum      TEXT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_backup_runs_tenant ON backup_runs (tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS backup_restore_requests (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  backup_run_id BIGINT REFERENCES backup_runs(id),
  point_in_time TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'requested', -- requested|approved|restoring|restored|verified|rejected
  reason        TEXT,
  requested_by  INTEGER,
  approved_by   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_backup_restore_tenant ON backup_restore_requests (tenant_id, created_at DESC);

-- ════════════════════ INF-07 DATA WAREHOUSE ════════════════════
-- Star-schema факт визитов, наполняется ETL-эндпоинтом из appointments.
CREATE TABLE IF NOT EXISTS dwh_fact_visits (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  visit_date    DATE NOT NULL,
  master_name   TEXT,
  service_name  TEXT,
  service_category TEXT,
  source        TEXT,
  status        TEXT,
  revenue       NUMERIC(14,2) NOT NULL DEFAULT 0,
  visits        INTEGER NOT NULL DEFAULT 0,
  src_appointment_id BIGINT,
  loaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, src_appointment_id)
);
CREATE INDEX IF NOT EXISTS ix_dwh_fact_visits_tenant ON dwh_fact_visits (tenant_id, visit_date DESC);

CREATE TABLE IF NOT EXISTS dwh_etl_runs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  pipeline      TEXT NOT NULL DEFAULT 'fact_visits',
  status        TEXT NOT NULL DEFAULT 'running',-- running|success|failed
  rows_loaded   INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  quality_issues INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_dwh_etl_runs_tenant ON dwh_etl_runs (tenant_id, started_at DESC);

-- ════════════════════ INT-04 MARKETPLACE ════════════════════
CREATE TABLE IF NOT EXISTS mp_developers (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  email         TEXT,
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  payout_share  NUMERIC(4,2) NOT NULL DEFAULT 0.70, -- 70% разработчику
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mp_apps (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  developer_id  BIGINT REFERENCES mp_developers(id),
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',  -- crm|marketing|payments|analytics|communications|other
  short_desc    TEXT,
  description   TEXT,
  icon_url      TEXT,
  screenshots   JSONB NOT NULL DEFAULT '[]',
  iframe_url    TEXT,
  scopes        JSONB NOT NULL DEFAULT '[]',    -- запрашиваемые API-права
  version       TEXT NOT NULL DEFAULT '1.0.0',
  changelog     TEXT,
  price_model   TEXT NOT NULL DEFAULT 'free',   -- free|paid|subscription
  price         NUMERIC(10,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|in_review|approved|rejected|published
  security_scan TEXT NOT NULL DEFAULT 'pending',-- pending|passed|failed
  review_note   TEXT,
  rating        NUMERIC(3,2) NOT NULL DEFAULT 0,
  installs      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_mp_apps_tenant ON mp_apps (tenant_id, category);

CREATE TABLE IF NOT EXISTS mp_installs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  app_id        BIGINT NOT NULL REFERENCES mp_apps(id),
  config        JSONB NOT NULL DEFAULT '{}',
  scoped_token  TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- active|disabled
  installed_by  INTEGER,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, app_id)
);
CREATE INDEX IF NOT EXISTS ix_mp_installs_tenant ON mp_installs (tenant_id);

CREATE TABLE IF NOT EXISTS mp_reviews (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  app_id        BIGINT NOT NULL REFERENCES mp_apps(id),
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,
  author_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mp_reviews_app ON mp_reviews (tenant_id, app_id);

-- ════════════════════ RLS-ИЗОЛЯЦИЯ (эталон 115) ════════════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gbp_profile','gbp_posts','gbp_qna','gbp_metrics',
    'fin_branch_targets',
    'backup_config','backup_runs','backup_restore_requests',
    'dwh_fact_visits','dwh_etl_runs',
    'mp_developers','mp_apps','mp_installs','mp_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_tenant', t);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I_id_seq TO app_tenant', t);
  END LOOP;
END $$;

-- ════════════════════ ПРАВА (RBAC) ════════════════════
-- read — admin/manager/reception; manage — admin/manager.
DO $$
DECLARE p TEXT;
BEGIN
  FOREACH p IN ARRAY ARRAY['gbp.read','kpi_branches.read','backup.read','dwh.read','marketplace.read'] LOOP
    UPDATE roles SET permissions = permissions || to_jsonb(ARRAY[p])
      WHERE code IN ('admin','manager','reception')
        AND NOT (permissions @> to_jsonb(ARRAY[p])) AND NOT (permissions @> '["*"]'::jsonb);
  END LOOP;
  FOREACH p IN ARRAY ARRAY['gbp.manage','kpi_branches.manage','backup.manage','dwh.manage','marketplace.manage'] LOOP
    UPDATE roles SET permissions = permissions || to_jsonb(ARRAY[p])
      WHERE code IN ('admin','manager')
        AND NOT (permissions @> to_jsonb(ARRAY[p])) AND NOT (permissions @> '["*"]'::jsonb);
  END LOOP;
END $$;
