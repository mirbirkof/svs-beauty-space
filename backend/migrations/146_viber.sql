-- 146: COM-06 — Viber Business Messages
-- Повний набір таблиць для Viber-каналу: конфіг бота, підписники,
-- журнал повідомлень, розсилки, сценарії бота, ставки вартості.
-- Кожна таблиця: tenant_id, RLS tenant_isolation, GRANTs для app_tenant.
-- Ідемпотентно (IF NOT EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

-- ── 1. Конфігурація Viber-бота (одна на тенант) ─────────────────────
CREATE TABLE IF NOT EXISTS viber_bot_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  auth_token           TEXT,                                    -- токен Viber PA (може бути NULL якщо з env)
  webhook_url          TEXT,
  bot_name             VARCHAR(100),
  bot_avatar_url       TEXT,
  bot_description      TEXT,
  welcome_message      TEXT,
  default_keyboard     JSONB,                                   -- головне меню (KeyboardObject)
  mode                 VARCHAR(20) NOT NULL DEFAULT 'hybrid',  -- bot / operator / hybrid
  session_timeout_min  INTEGER NOT NULL DEFAULT 30,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  viber_account_id     VARCHAR(100),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (salon_id)
);

ALTER TABLE viber_bot_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_bot_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_bot_config;
CREATE POLICY tenant_isolation ON viber_bot_config
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_bot_config TO app_tenant;

-- ── 2. Підписники бота ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS viber_subscribers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  viber_user_id    VARCHAR(100) NOT NULL,
  client_id        INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name             VARCHAR(200),
  avatar_url       TEXT,
  phone            VARCHAR(20),
  language         VARCHAR(5),
  country          VARCHAR(5),
  device_type      VARCHAR(20),
  api_version      INTEGER,
  status           VARCHAR(20) NOT NULL DEFAULT 'active', -- active / unsubscribed / blocked
  subscribed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsubscribed_at  TIMESTAMPTZ,
  last_message_at  TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ,
  tags             TEXT[],
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (viber_user_id)
);

CREATE INDEX IF NOT EXISTS idx_viber_subs_salon_status
  ON viber_subscribers (salon_id, status);
CREATE INDEX IF NOT EXISTS idx_viber_subs_client
  ON viber_subscribers (client_id);

ALTER TABLE viber_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_subscribers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_subscribers;
CREATE POLICY tenant_isolation ON viber_subscribers
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_subscribers TO app_tenant;

-- ── 3. Сценарії чат-бота ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS viber_bot_scenarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name             VARCHAR(200) NOT NULL,
  trigger_type     VARCHAR(20) NOT NULL, -- keyword / button / first_message / regex
  trigger_value    TEXT NOT NULL,
  flow             JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  priority         INTEGER NOT NULL DEFAULT 0,
  stats_triggered  INTEGER NOT NULL DEFAULT 0,
  stats_completed  INTEGER NOT NULL DEFAULT 0,
  stats_handover   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_viber_scenarios_salon
  ON viber_bot_scenarios (salon_id, is_active, priority DESC);

ALTER TABLE viber_bot_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_bot_scenarios FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_bot_scenarios;
CREATE POLICY tenant_isolation ON viber_bot_scenarios
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_bot_scenarios TO app_tenant;

-- ── 4. Розсилки ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS viber_broadcasts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name             VARCHAR(200) NOT NULL,
  message_type     VARCHAR(20) NOT NULL,
  content          JSONB NOT NULL,
  audience_type    VARCHAR(20) DEFAULT 'all', -- all / segment / manual
  audience_filter  JSONB,
  audience_count   INTEGER,
  status           VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft/scheduled/sending/completed/cancelled
  scheduled_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  stats_sent       INTEGER NOT NULL DEFAULT 0,
  stats_delivered  INTEGER NOT NULL DEFAULT 0,
  stats_seen       INTEGER NOT NULL DEFAULT 0,
  stats_clicked    INTEGER NOT NULL DEFAULT 0,
  stats_failed     INTEGER NOT NULL DEFAULT 0,
  estimated_cost   DECIMAL(12,2),
  actual_cost      DECIMAL(12,2),
  created_by       INTEGER, -- soft FK → employees.id
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_viber_broadcasts_salon_status
  ON viber_broadcasts (salon_id, status);

ALTER TABLE viber_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_broadcasts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_broadcasts;
CREATE POLICY tenant_isolation ON viber_broadcasts
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_broadcasts TO app_tenant;

-- ── 5. Журнал повідомлень ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS viber_messages (
  id                    BIGSERIAL PRIMARY KEY,
  salon_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  subscriber_id         UUID REFERENCES viber_subscribers(id) ON DELETE SET NULL,
  direction             VARCHAR(10) NOT NULL, -- inbound / outbound
  message_type          VARCHAR(20) NOT NULL, -- text/picture/video/file/contact/location/sticker/rich_media
  content               JSONB NOT NULL DEFAULT '{}'::jsonb,
  viber_message_token   BIGINT,
  status                VARCHAR(20) NOT NULL DEFAULT 'sent', -- sent/delivered/seen/failed
  status_updated_at     TIMESTAMPTZ,
  error_code            INTEGER,
  error_message         TEXT,
  is_broadcast          BOOLEAN NOT NULL DEFAULT FALSE,
  broadcast_id          UUID REFERENCES viber_broadcasts(id) ON DELETE SET NULL,
  bot_scenario_id       UUID REFERENCES viber_bot_scenarios(id) ON DELETE SET NULL,
  operator_id           INTEGER, -- soft FK → employees.id
  cost_type             VARCHAR(20), -- transactional / promotional / session
  cost_amount           DECIMAL(10,4) NOT NULL DEFAULT 0,
  buttons_clicked       JSONB,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ,
  seen_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_viber_messages_dialog
  ON viber_messages (salon_id, subscriber_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_viber_messages_broadcast
  ON viber_messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viber_messages_journal
  ON viber_messages (salon_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_viber_messages_token
  ON viber_messages (viber_message_token)
  WHERE viber_message_token IS NOT NULL;

ALTER TABLE viber_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_messages;
CREATE POLICY tenant_isolation ON viber_messages
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_messages TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE viber_messages_id_seq TO app_tenant;

-- ── 6. Ставки вартості повідомлень ──────────────────────────────────
CREATE TABLE IF NOT EXISTS viber_cost_rates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  cost_type        VARCHAR(20) NOT NULL, -- transactional / promotional / session
  rate_per_message DECIMAL(10,4) NOT NULL,
  currency         VARCHAR(3) NOT NULL DEFAULT 'UAH',
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_viber_cost_rates_salon
  ON viber_cost_rates (salon_id, cost_type, effective_from DESC);

ALTER TABLE viber_cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE viber_cost_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viber_cost_rates;
CREATE POLICY tenant_isolation ON viber_cost_rates
  USING      (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id))
  WITH CHECK (salon_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, salon_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON viber_cost_rates TO app_tenant;

-- ── 7. Індекс omni_channels для маршрутизації webhook Viber ──────────
-- (аналогічно 128_instagram_channel.sql для ig_user_id)
CREATE INDEX IF NOT EXISTS idx_omni_channels_viber_account
  ON omni_channels ((config->>'viber_account_id'))
  WHERE channel = 'viber';

-- ── 8. Дефолтні ставки (орієнтовні UAH) ────────────────────────────
-- Виконується лише для default тенанта — інші тенанти можуть задати свої.
-- Використовуємо DO $$ щоб не падати якщо current_tenant_id() недоступна.
DO $$
BEGIN
  INSERT INTO viber_cost_rates (salon_id, cost_type, rate_per_message, currency, effective_from)
  VALUES
    ('00000000-0000-0000-0000-000000000000'::uuid, 'transactional', 0.05, 'UAH', CURRENT_DATE),
    ('00000000-0000-0000-0000-000000000000'::uuid, 'promotional',   0.08, 'UAH', CURRENT_DATE),
    ('00000000-0000-0000-0000-000000000000'::uuid, 'session',       0.03, 'UAH', CURRENT_DATE)
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  NULL; -- ігноруємо якщо тенант не існує
END $$;

COMMIT;
