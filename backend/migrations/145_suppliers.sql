-- 145: SLS-05 Поставщики — расширение существующей таблицы suppliers (005)
-- и создание дочерних таблиц: contacts, products, price_history, ratings, documents.
-- suppliers.id остаётся SERIAL INTEGER (FK из purchase_orders, stock_receipts, auto_purchase_rules).
-- tenant_id добавляем через ALTER TABLE IF NOT EXISTS, чтобы не сломать FK-цепочку.

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. РАСШИРЯЕМ ТАБЛИЦУ suppliers (уже существует в 005, без tenant_id)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS tenant_id          UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS legal_name         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS tax_id             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS legal_address      TEXT,
  ADD COLUMN IF NOT EXISTS actual_address     TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_address  TEXT,
  ADD COLUMN IF NOT EXISTS website            VARCHAR(500),
  ADD COLUMN IF NOT EXISTS bank_name          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_account       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_mfo           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_order_amount   DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_percent   DECIMAL(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency           VARCHAR(3) DEFAULT 'UAH',
  ADD COLUMN IF NOT EXISTS default_delivery   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS rating             DECIMAL(3,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status             VARCHAR(20) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS branch_id          UUID,
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();

-- backfill updated_at for existing rows
UPDATE suppliers SET updated_at = created_at WHERE updated_at IS NULL;

-- tenant_id DEFAULT: встановлюємо лише якщо функція існує
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_tenant_id') THEN
    ALTER TABLE suppliers
      ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();
  END IF;
END $$;

-- Індекси на suppliers
CREATE INDEX IF NOT EXISTS idx_suppliers_status      ON suppliers(status);
CREATE INDEX IF NOT EXISTS idx_suppliers_name        ON suppliers(name);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant      ON suppliers(tenant_id);

-- RLS на suppliers
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON suppliers;
CREATE POLICY tenant_isolation ON suppliers
  USING (tenant_id IS NULL OR tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE suppliers_id_seq TO app_tenant;


-- ─────────────────────────────────────────────────────────────
-- 2. КОНТАКТНІ ОСОБИ ПОСТАЧАЛЬНИКА
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_contacts (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  position    VARCHAR(100),
  phone       VARCHAR(20),
  email       VARCHAR(255),
  telegram    VARCHAR(100),
  is_primary  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sc_supplier ON supplier_contacts(tenant_id, supplier_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_contacts TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE supplier_contacts_id_seq TO app_tenant;


-- ─────────────────────────────────────────────────────────────
-- 3. КАТАЛОГ ТОВАРІВ ПОСТАЧАЛЬНИКА
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_products (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id         INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id          TEXT REFERENCES products(id) ON DELETE CASCADE,
  supplier_sku        VARCHAR(100),
  purchase_price      DECIMAL(10,2) NOT NULL,
  min_quantity        INTEGER DEFAULT 1,
  delivery_days       INTEGER DEFAULT 3,
  in_stock            BOOLEAN DEFAULT true,
  last_price_update   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products(tenant_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_sp_product  ON supplier_products(tenant_id, product_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_products'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_products TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE supplier_products_id_seq TO app_tenant;


-- ─────────────────────────────────────────────────────────────
-- 4. ИСТОРИІЯ ЦІН
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_price_history (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_product_id BIGINT NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  old_price           DECIMAL(10,2),
  new_price           DECIMAL(10,2) NOT NULL,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sph_sp ON supplier_price_history(tenant_id, supplier_product_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_price_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_price_history TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE supplier_price_history_id_seq TO app_tenant;


-- ─────────────────────────────────────────────────────────────
-- 5. РЕЙТИНГИ / ОЦІНКИ
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_ratings (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  score             INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  delivery_on_time  BOOLEAN,
  quality_ok        BOOLEAN,
  comment           TEXT,
  rated_by          INTEGER,   -- employees.id (soft FK — employees може бути UUID або INT в різних схемах)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sr_supplier ON supplier_ratings(tenant_id, supplier_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_ratings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_ratings TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE supplier_ratings_id_seq TO app_tenant;


-- ─────────────────────────────────────────────────────────────
-- 6. ДОКУМЕНТИ ПОСТАЧАЛЬНИКА
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_documents (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  doc_type    VARCHAR(50) NOT NULL DEFAULT 'other', -- 'contract'|'pricelist'|'certificate'|'other'
  title       VARCHAR(255) NOT NULL,
  file_url    VARCHAR(500) NOT NULL,
  version     INTEGER DEFAULT 1,
  valid_from  DATE,
  valid_until DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sd_supplier ON supplier_documents(tenant_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_sd_expiry   ON supplier_documents(tenant_id, valid_until) WHERE valid_until IS NOT NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_documents TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE supplier_documents_id_seq TO app_tenant;

COMMIT;
