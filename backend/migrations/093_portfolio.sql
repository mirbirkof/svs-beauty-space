-- SAL-09 — Портфолио работ "До/После" (Before/After)
CREATE TABLE IF NOT EXISTS portfolio_items (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  title         TEXT,
  description   TEXT,
  before_url    TEXT,
  after_url     TEXT NOT NULL,
  photo_urls    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- доп. фото процесса
  client_id     BIGINT,
  master_id     BIGINT,
  service_id    BIGINT,
  appointment_id BIGINT,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_public     BOOLEAN NOT NULL DEFAULT false,      -- показывать в публичной галерее
  featured      BOOLEAN NOT NULL DEFAULT false,
  sort_order    INT,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_tenant ON portfolio_items (tenant_id, is_public);
CREATE INDEX IF NOT EXISTS idx_portfolio_master ON portfolio_items (master_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_service ON portfolio_items (service_id);
