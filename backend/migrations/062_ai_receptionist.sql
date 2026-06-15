-- 062: AI-01 AI Receptionist — виртуальный администратор 24/7.
-- Распознаёт намерения (intent), ведёт диалог, отвечает на FAQ о ценах/услугах/часах,
-- помогает с записью, передаёт оператору (handoff) при жалобе/непонимании/явном запросе.
-- Каналы: telegram | whatsapp | website | phone. Движок: lib/llm (как AI-04/AI-08).
BEGIN;

-- 062.1 Диалоги
CREATE TABLE IF NOT EXISTS ai_conversations (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id         INTEGER,                       -- мягкая ссылка на clients.id (без FK: канал может писать до идентификации)
  channel           TEXT NOT NULL DEFAULT 'website',-- telegram | whatsapp | website | phone
  channel_chat_id   TEXT,                          -- ID чата в канале (для группировки)
  status            TEXT NOT NULL DEFAULT 'active', -- active | handed_off | closed
  handed_off_to     INTEGER,                       -- employees/users.id оператора
  handed_off_at     TIMESTAMPTZ,
  handed_off_reason TEXT,                           -- complaint | misunderstanding | explicit_request | complex
  messages_count    INTEGER NOT NULL DEFAULT 0,
  ai_handled        BOOLEAN NOT NULL DEFAULT TRUE,  -- false если был handoff
  last_intent       TEXT,
  miss_streak       INTEGER NOT NULL DEFAULT 0,     -- сколько подряд непонятых сообщений
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ai_conv_status  ON ai_conversations (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_conv_client  ON ai_conversations (client_id);
CREATE INDEX IF NOT EXISTS ix_ai_conv_channel ON ai_conversations (channel, channel_chat_id);

-- 062.2 Сообщения диалога
CREATE TABLE IF NOT EXISTS ai_messages (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  conversation_id   BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,                  -- user | assistant | system
  content           TEXT NOT NULL,
  intent            TEXT,                           -- book_appointment | cancel | reschedule | price_inquiry | hours | address | services_list | speak_to_human | complaint | review | other
  intent_confidence NUMERIC(3,2),
  entities          JSONB,                          -- { service, date, time, master, name, phone }
  action_taken      TEXT,                           -- faq_answered | handoff | suggested_booking | clarify
  action_result     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ai_msg_conv ON ai_messages (conversation_id, created_at);

-- 062.3 Настройки ресепшна (по филиалу; branch_id NULL = глобальные)
CREATE TABLE IF NOT EXISTS ai_receptionist_config (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id           INTEGER,
  greeting_message    TEXT,
  tone                TEXT NOT NULL DEFAULT 'friendly',   -- friendly | professional | casual
  language            TEXT NOT NULL DEFAULT 'uk',
  handoff_after_misses INTEGER NOT NULL DEFAULT 2,
  working_hours       JSONB,                              -- null = 24/7
  custom_faq          JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ q, a }]
  enabled_channels    TEXT[] NOT NULL DEFAULT '{telegram,website}',
  model               TEXT,                               -- null = дефолтный каскад lib/llm
  max_tokens          INTEGER NOT NULL DEFAULT 600,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_cfg_branch ON ai_receptionist_config (tenant_id, COALESCE(branch_id, -1));

-- 062.4 Обратная связь оператора на ответы AI (для улучшения)
CREATE TABLE IF NOT EXISTS ai_feedback (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  message_id      BIGINT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  feedback_type   TEXT NOT NULL,                    -- wrong_intent | bad_response | good_response
  correct_intent  TEXT,
  comment         TEXT,
  given_by        INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ai_fb_msg ON ai_feedback (message_id);

-- RLS: изоляция по тенанту (как у всех таблиц)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_conversations','ai_messages','ai_receptionist_config','ai_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

-- Права рабочей роли приложения
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_conversations, ai_messages, ai_receptionist_config, ai_feedback TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE ai_conversations_id_seq, ai_messages_id_seq, ai_receptionist_config_id_seq, ai_feedback_id_seq TO app_tenant;

COMMIT;
