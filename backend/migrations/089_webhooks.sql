-- INT-03 — Исходящие вебхуки (Outgoing Webhooks)
-- Эндпоинты-подписчики на доменные события + журнал доставок.
CREATE TABLE IF NOT EXISTS webhooks (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  url         TEXT NOT NULL,
  description TEXT,
  events      JSONB NOT NULL DEFAULT '["*"]'::jsonb,  -- список event_type или ["*"]
  secret      TEXT,                                   -- для HMAC-SHA256 подписи
  active      BOOLEAN NOT NULL DEFAULT true,
  failure_count INT NOT NULL DEFAULT 0,
  last_status   INT,
  last_delivered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks (tenant_id, active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  webhook_id  BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  status_code INT,
  ok          BOOLEAN NOT NULL DEFAULT false,
  error       TEXT,
  attempt     INT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wh_deliv ON webhook_deliveries (webhook_id, created_at DESC);
