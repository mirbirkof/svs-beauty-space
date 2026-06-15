-- COM-05/06/07/08/09 — Омниканальный центр общения (Omnichannel)
-- Единый inbox оператора по каналам: whatsapp, viber, messenger, telegram, sms, call, instagram.

-- Конфигурация каналов (ключи/токены провайдеров, вкл/выкл).
CREATE TABLE IF NOT EXISTS omni_channels (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  channel     TEXT NOT NULL,              -- whatsapp|viber|messenger|telegram|sms|call|instagram
  enabled     BOOLEAN NOT NULL DEFAULT false,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {token, phone_id, ...} (секреты)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel)
);

-- Диалоги (по одному на собеседника+канал).
CREATE TABLE IF NOT EXISTS omni_conversations (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  channel       TEXT NOT NULL,
  external_id   TEXT,                     -- id чата/пользователя у провайдера
  client_id     BIGINT,                   -- привязка к клиенту CRM
  contact_name  TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|pending|closed
  assigned_to   BIGINT,
  unread        INT NOT NULL DEFAULT 0,
  last_message  TEXT,
  last_message_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_omni_conv ON omni_conversations (tenant_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_omni_conv_status ON omni_conversations (tenant_id, status, last_message_at DESC);

-- Сообщения.
CREATE TABLE IF NOT EXISTS omni_messages (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id(),
  conversation_id BIGINT NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,          -- in|out
  channel         TEXT NOT NULL,
  body            TEXT,
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'sent',   -- sent|delivered|read|failed
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_omni_msg_conv ON omni_messages (conversation_id, created_at);
