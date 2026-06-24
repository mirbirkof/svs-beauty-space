-- 159: SAL-09 Before/After — дотягування поверх portfolio_items (не дублюємо!).
-- Додаємо модерацію (uploaded→moderated→published/rejected), категорію, прапор
-- "в портфоліо", лічильник переглядів, дату зйомки. Окрема таблиця photo_consents —
-- згода клієнта на публікацію (без неї фото не публікується). tenant_id+RLS як решта.
BEGIN;

-- ── 159.1 Розширення portfolio_items ────────────────────────────────────────
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS category        VARCHAR(30);   -- haircut|coloring|nails|extensions|makeup|cosmetology|other
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS status          VARCHAR(20) DEFAULT 'uploaded';  -- uploaded|moderated|published|rejected|removed
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS in_portfolio    BOOLEAN DEFAULT FALSE;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS moderated_by    BIGINT;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS moderated_at    TIMESTAMPTZ;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS view_count      INTEGER DEFAULT 0;
ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS shot_at         TIMESTAMPTZ;

-- ── 159.2 Згоди клієнтів на фото ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS photo_consents (
  id             BIGSERIAL    PRIMARY KEY,
  tenant_id      UUID         NOT NULL DEFAULT current_tenant_id(),
  client_id      BIGINT       NOT NULL,
  consent_type   VARCHAR(20)  NOT NULL,    -- internal_only|portfolio|social_media|advertising
  granted_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,              -- NULL = безстроково
  revoked_at     TIMESTAMPTZ,
  revoke_reason  TEXT,
  signature_url  VARCHAR(500),
  signed_by_name VARCHAR(200) NOT NULL,
  document_url   VARCHAR(500),
  collected_by   BIGINT,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active|expired|revoked
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photo_consents_client ON photo_consents (client_id, status);
CREATE INDEX IF NOT EXISTS idx_photo_consents_expires ON photo_consents (expires_at);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.photo_consents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.photo_consents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.photo_consents';
  EXECUTE 'CREATE POLICY tenant_isolation ON public.photo_consents '
    'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
    'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON photo_consents TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE photo_consents_id_seq TO app_tenant;

COMMIT;
