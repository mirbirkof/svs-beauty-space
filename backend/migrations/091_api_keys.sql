-- INT-01/INT-02 — API-ключи для публичного API (API Gateway + Public API)
CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  name        TEXT NOT NULL,
  key_prefix  TEXT NOT NULL,              -- видимая часть для UI (svs_live_xxxx)
  key_hash    TEXT NOT NULL,              -- sha256 полного ключа (ключ показывается 1 раз)
  scopes      JSONB NOT NULL DEFAULT '["read"]'::jsonb,  -- read | write | <ресурс>.read
  rate_limit_per_min INT NOT NULL DEFAULT 120,
  active      BOOLEAN NOT NULL DEFAULT true,
  request_count BIGINT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, active);
