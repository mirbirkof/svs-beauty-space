-- 162: INF-01 Event Bus — дотягування поверх domain_events/lib/event-bus.
-- Транспорт (NATS/Redis) — зовнішня інфра, лишається стабом (правило: неприєднаний
-- зовнішній конектор = готово). Тут закриваємо РЕАЛЬНІ функціональні дірки в Postgres:
-- реєстр типів подій, підписки, dead letter queue, журнал replay.
-- Integer SERIAL модель (як domain_events). Event-type звʼязуємо по NAME (TEXT).
BEGIN;

-- ── 162.1 Реєстр типів подій ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_types (
  id              SERIAL       PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,    -- 'crm.client.created'
  domain          VARCHAR(32)  NOT NULL DEFAULT 'CRM',
  version         INTEGER      NOT NULL DEFAULT 1,
  json_schema     JSONB        NOT NULL DEFAULT '{}',
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  retention_hours INTEGER      NOT NULL DEFAULT 168,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_types_domain ON event_types (domain);

-- ── 162.2 Підписки ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id              SERIAL       PRIMARY KEY,
  event_type_name VARCHAR(128) NOT NULL,            -- ref event_types.name (по імені, прагматично)
  subscriber_name VARCHAR(128) NOT NULL,
  subject_pattern VARCHAR(256) NOT NULL DEFAULT '*',
  consumer_group  VARCHAR(128) NOT NULL DEFAULT 'default',
  max_retries     INTEGER      NOT NULL DEFAULT 5,
  retry_delay_ms  INTEGER      NOT NULL DEFAULT 1000,
  timeout_ms      INTEGER      NOT NULL DEFAULT 30000,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (event_type_name, subscriber_name)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON event_subscriptions (subscriber_name);

-- ── 162.3 Dead Letter Queue ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id                SERIAL       PRIMARY KEY,
  original_event_id BIGINT,                         -- ref domain_events.id (для reprocess)
  event_type        VARCHAR(128) NOT NULL,
  subscription_id   INTEGER,
  tenant_id         UUID,
  event_payload     JSONB        NOT NULL DEFAULT '{}',
  error_message     TEXT,
  retry_count       INTEGER      NOT NULL DEFAULT 0,
  original_ts       TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reprocessed_at    TIMESTAMPTZ,
  status            VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending|reprocessed|discarded
  UNIQUE (original_event_id)
);
CREATE INDEX IF NOT EXISTS idx_dlq_status ON dead_letter_queue (status);
CREATE INDEX IF NOT EXISTS idx_dlq_failed_at ON dead_letter_queue (failed_at);

-- ── 162.4 Журнал replay ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_replay_log (
  id              SERIAL       PRIMARY KEY,
  initiated_by    TEXT,
  event_type      VARCHAR(128),                      -- NULL = усі типи
  tenant_id       UUID,
  replay_from     TIMESTAMPTZ  NOT NULL,
  replay_to       TIMESTAMPTZ  NOT NULL,
  filter_criteria JSONB,
  total_events    INTEGER      NOT NULL DEFAULT 0,
  replayed_events INTEGER      NOT NULL DEFAULT 0,
  failed_events   INTEGER      NOT NULL DEFAULT 0,
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed|cancelled
  is_dry_run      BOOLEAN      NOT NULL DEFAULT FALSE,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_replay_status ON event_replay_log (status);
CREATE INDEX IF NOT EXISTS idx_replay_created ON event_replay_log (created_at DESC);

COMMIT;
