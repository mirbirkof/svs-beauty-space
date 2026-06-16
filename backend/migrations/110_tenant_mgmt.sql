-- 110: SAS-06 Tenant Management. Операционная панель платформы: онбординг,
-- health-мониторинг, тикеты поддержки, usage. Платформенные таблицы (как
-- saas_plans/tenant_licenses — БЕЗ per-tenant RLS): суперадмин видит всех,
-- tenant-facing запросы фильтруют по current_tenant_id() явно.
BEGIN;

-- Прогресс онбординга нового салона (5 шагов).
CREATE TABLE IF NOT EXISTS tenant_onboarding (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID UNIQUE NOT NULL,
  current_step       SMALLINT NOT NULL DEFAULT 1,         -- 1..5
  steps_completed    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["registration","profile",...]
  completion_percent SMALLINT NOT NULL DEFAULT 0,         -- 0..100
  welcome_emails_sent SMALLINT NOT NULL DEFAULT 0,
  assigned_csm       INTEGER,
  notes              TEXT,
  metadata           JSONB DEFAULT '{}'::jsonb,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- История health-проверок тенанта.
CREATE TABLE IF NOT EXISTS tenant_health_checks (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  check_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  health_score   SMALLINT NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  category       TEXT NOT NULL,                            -- healthy|warning|critical
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  alerts         JSONB DEFAULT '[]'::jsonb,
  previous_score SMALLINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_thc_tenant ON tenant_health_checks(tenant_id, check_date DESC);
CREATE INDEX IF NOT EXISTS idx_thc_category ON tenant_health_checks(category, check_date DESC);

-- Тикеты техподдержки.
CREATE TABLE IF NOT EXISTS tenant_support_tickets (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  ticket_number     TEXT UNIQUE NOT NULL,                 -- TKT-NNNNNN
  subject           TEXT NOT NULL,
  description       TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'question',     -- bug|question|feature_request|billing|data
  priority          TEXT NOT NULL DEFAULT 'medium',       -- low|medium|high|urgent
  status            TEXT NOT NULL DEFAULT 'open',         -- open|in_progress|waiting_customer|resolved|closed
  created_by        INTEGER,
  created_by_name   TEXT,
  assigned_to       INTEGER,
  first_response_at TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  attachments       JSONB DEFAULT '[]'::jsonb,
  internal_notes    TEXT,
  tags              TEXT[] DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tst_tenant ON tenant_support_tickets(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tst_status ON tenant_support_tickets(status, priority);
CREATE INDEX IF NOT EXISTS idx_tst_assigned ON tenant_support_tickets(assigned_to);

-- Ответы/переписка по тикету (internal=true — не видно тенанту).
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tenant_support_tickets(id) ON DELETE CASCADE,
  author_id   INTEGER,
  author_name TEXT,
  is_staff    BOOLEAN DEFAULT FALSE,
  internal    BOOLEAN DEFAULT FALSE,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tr_ticket ON ticket_replies(ticket_id, created_at);

-- Агрегаты использования ресурсов по периодам.
CREATE TABLE IF NOT EXISTS tenant_usage_stats (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  period_start       TIMESTAMPTZ NOT NULL,
  period_end         TIMESTAMPTZ NOT NULL,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  storage_used_mb    INTEGER NOT NULL DEFAULT 0,
  active_users       INTEGER NOT NULL DEFAULT 0,
  appointments_count INTEGER NOT NULL DEFAULT 0,
  sms_sent           INTEGER NOT NULL DEFAULT 0,
  emails_sent        INTEGER NOT NULL DEFAULT 0,
  cost_estimate_uah  NUMERIC(10,2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_tus_period ON tenant_usage_stats(period_start DESC);

-- Платформенные таблицы — доступ роли app_tenant без RLS (кросс-тенантные операции суперадмина).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_onboarding, tenant_health_checks,
  tenant_support_tickets, ticket_replies, tenant_usage_stats TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE tenant_onboarding_id_seq, tenant_health_checks_id_seq,
  tenant_support_tickets_id_seq, ticket_replies_id_seq, tenant_usage_stats_id_seq TO app_tenant;

COMMIT;
