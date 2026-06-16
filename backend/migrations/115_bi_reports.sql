-- INF-08 BI Platform — сохранённые пользовательские отчёты.
-- Прагматично: одна таблица определений отчётов. Без DWH/ETL, без кэш-прогонов,
-- без версионирования — для одного салона избыточно. Сами данные тянутся вживую
-- из основных таблиц через белый список датасетов (routes/bi.js), юзер не пишет SQL.

CREATE TABLE IF NOT EXISTS bi_reports (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  description   TEXT,
  dataset       TEXT NOT NULL,                    -- ключ из DATASETS (appointments|clients|orders|order_items|payments)
  config        JSONB NOT NULL DEFAULT '{}',      -- {dimensions[],measures[],filters[],sort,limit,viz}
  is_favorite   BOOLEAN NOT NULL DEFAULT FALSE,
  is_shared     BOOLEAN NOT NULL DEFAULT TRUE,    -- виден всем в тенанте (для 1 салона — да)
  created_by    INTEGER,
  created_by_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_bi_reports_tenant  ON bi_reports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_bi_reports_dataset ON bi_reports (tenant_id, dataset);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bi_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bi_reports TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE bi_reports_id_seq TO app_tenant;
