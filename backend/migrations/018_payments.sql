-- 018: M29 Payment Gateway — Mono Acquiring
-- Таблица payments уже существует (скелет из ранней миграции, пустая).
-- Аддитивно расширяем под Mono: provider/invoice_id/page_url/raw/updated_at.
BEGIN;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mono';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS page_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS ccy INTEGER NOT NULL DEFAULT 980;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw JSONB;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE payments ALTER COLUMN status SET DEFAULT 'created';
-- старая колонка method (NOT NULL без дефолта) — даём дефолт чтобы новый код не падал
ALTER TABLE payments ALTER COLUMN method SET DEFAULT 'online';
ALTER TABLE payments ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();

-- один invoice_id — одна запись (идемпотентность вебхуков)
CREATE UNIQUE INDEX IF NOT EXISTS payments_invoice_key
  ON payments (provider, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_payments_pending
  ON payments (status) WHERE status IN ('created','processing','hold');

-- RLS: страховка если 015 не повесила политику на payments
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payments;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- права для рабочей роли приложения (новые объекты могли создаться владельцем)
GRANT SELECT, INSERT, UPDATE ON payments TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE payments_id_seq TO app_tenant;

COMMIT;
