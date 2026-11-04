-- 319 (Босс 04.11, price-materials-0411): «у мініапі ціни на волосся лише за роботу без матеріалу — вводить в оману».
-- Модель: процедура → варіант довжини → робота (окрема послуга CRM) + матеріал (окрема послуга / включено / за фактом).
-- Ціни роботи й матеріалу НЕ дублюються: беруться живими з services.price привʼязаних послуг
-- (material_price — лише для режиму 'extra' «за фактом від X», якщо відомо). Лише CREATE/ADD — наявні дані не змінюються.
BEGIN;

CREATE TABLE IF NOT EXISTS service_procedures (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id(),
  key               TEXT NOT NULL,
  title             TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'Волосся',
  alias_service_ids INTEGER[] NOT NULL DEFAULT '{}',   -- старі/паралельні послуги, які ховаються за карткою процедури
  note              TEXT,
  sort              INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_procedures_key ON service_procedures (tenant_id, key);

CREATE TABLE IF NOT EXISTS service_length_variants (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id(),
  procedure_id        INTEGER NOT NULL REFERENCES service_procedures(id),
  length_code         TEXT NOT NULL,              -- '2', '3-4' …
  length_label        TEXT NOT NULL,              -- «2 довжина»
  cm_from             INTEGER,
  cm_to               INTEGER,                    -- NULL = не відомо / «понад cm_from»
  level               SMALLINT NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 6), -- силует 1..6
  work_service_id     INTEGER NOT NULL,           -- що йде у візит
  material_mode       TEXT NOT NULL DEFAULT 'separate' CHECK (material_mode IN ('separate','included','extra','none')),
  material_service_id INTEGER,                    -- для 'separate'
  material_price      NUMERIC(12,2),              -- для 'extra': «за фактом від X» (NULL = невідомо)
  material_note       TEXT,
  sort                INTEGER NOT NULL DEFAULT 0,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_slv_proc ON service_length_variants (tenant_id, procedure_id, sort);

-- запис із мініапу/бота: обраний варіант і орієнтовна сума (робота + матеріал) — підказка адміну до рахунку
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS length_variant_id INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price_estimate JSONB;

ALTER TABLE service_procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_procedures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_procedures;
CREATE POLICY tenant_isolation ON service_procedures
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

ALTER TABLE service_length_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_length_variants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_length_variants;
CREATE POLICY tenant_isolation ON service_length_variants
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
