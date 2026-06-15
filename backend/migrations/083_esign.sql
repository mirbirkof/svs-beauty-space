-- 083: MGT-07 E-Sign — електронний підпис документів. Запити на підписання,
-- захоплення підпису (drawn/typed/checkbox), криптофіксація (SHA-256 хеш документа),
-- аудит-трейл (IP/UA/гео/час, immutable). Прагматика під один салон: BIGSERIAL id,
-- tenant_id UUID + RLS (як 081), integer client/employee/visit. Звʼязок з MGT-06 documents.
BEGIN;

-- 083.1 Запити на підписання
CREATE TABLE IF NOT EXISTS esign_requests (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id      INTEGER,
  document_id    BIGINT REFERENCES documents(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'single',     -- single|multi_parallel|multi_sequential
  status         TEXT NOT NULL DEFAULT 'draft',       -- draft|pending|completed|expired|cancelled
  signing_method TEXT,                                -- tablet|telegram|web_link|qr
  sign_url_token TEXT UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '72 hours',
  reminder_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  visit_id       INTEGER,
  initiated_by   INTEGER,
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT,
  document_hash  TEXT NOT NULL DEFAULT '',            -- SHA-256 хеш документа на момент створення
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_esreq_tenant ON esign_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_esreq_doc    ON esign_requests (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS ix_esreq_token  ON esign_requests (sign_url_token);

-- 083.2 Підписи
CREATE TABLE IF NOT EXISTS esign_signatures (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  request_id          BIGINT NOT NULL REFERENCES esign_requests(id) ON DELETE CASCADE,
  signer_type         TEXT NOT NULL DEFAULT 'client', -- client|employee
  signer_client_id    INTEGER,
  signer_employee_id  INTEGER,
  signer_name         TEXT NOT NULL DEFAULT '',
  signer_email        TEXT,
  signer_phone        TEXT,
  signature_type      TEXT,                            -- drawn|typed|checkbox
  signature_image_svg TEXT,
  signature_png_id    BIGINT,                          -- -> files.id
  document_hash       TEXT,                            -- хеш на момент підписання
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|viewed|signed|rejected
  signed_at           TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  reject_reason       TEXT,
  ip_address          INET,
  user_agent          TEXT,
  device_info         JSONB,
  geolocation         JSONB,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_essig_request ON esign_signatures (request_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_essig_client  ON esign_signatures (tenant_id, signer_client_id);

-- 083.3 Аудит-трейл (immutable)
CREATE TABLE IF NOT EXISTS esign_audit_trail (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  request_id    BIGINT NOT NULL REFERENCES esign_requests(id) ON DELETE CASCADE,
  signature_id  BIGINT REFERENCES esign_signatures(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,  -- request_created|request_sent|document_viewed|signed|rejected|expired|cancelled|reminder_sent
  actor_type    TEXT,           -- client|employee|system
  actor_id      INTEGER,
  actor_name    TEXT,
  ip_address    INET,
  user_agent    TEXT,
  geolocation   JSONB,
  details       JSONB,
  document_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_esaudit_request ON esign_audit_trail (request_id, created_at);

-- Шаблони швидких запитів
CREATE TABLE IF NOT EXISTS esign_quick_templates (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  title         TEXT NOT NULL,
  document_template_id BIGINT,
  ttl_hours     INTEGER NOT NULL DEFAULT 72,
  signing_method TEXT NOT NULL DEFAULT 'web_link',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_esqt_tenant ON esign_quick_templates (tenant_id, active);

-- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['esign_requests','esign_signatures','esign_audit_trail','esign_quick_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON esign_requests, esign_signatures, esign_audit_trail, esign_quick_templates TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE esign_requests_id_seq, esign_signatures_id_seq, esign_audit_trail_id_seq, esign_quick_templates_id_seq TO app_tenant;

COMMIT;
