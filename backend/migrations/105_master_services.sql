-- 105: Реальна звʼязка майстер↔послуга в НАШІЙ CRM (джерело правди).
-- Проблема: ні в БД, ні в коді не було мапінгу хто яку послугу робить. masters.provides_services — лише boolean.
-- Онлайн-запис фільтрував майстрів по порожньому списку → показував ВСІХ на кожну послугу (баг з війками).
-- BeautyPro налаштований не до кінця (його settings можуть брехати), тому НЕ довіряємо йому наосліп:
-- сід беремо з BeautyPro mapping АЛЕ тільки для активних майстрів нашої БД — звільнені відсікаються автоматом.
-- Далі редагується вручну в адмінці (наша CRM = curation point).
BEGIN;

CREATE TABLE IF NOT EXISTS master_services (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  master_id    INTEGER NOT NULL,
  service_id   INTEGER NOT NULL,
  price        NUMERIC(12,2),            -- персональна ціна майстра на послугу (з BeautyPro), NULL = базова
  duration_min INTEGER,                  -- персональна тривалість, NULL = базова з services
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  source       TEXT NOT NULL DEFAULT 'manual', -- manual|beautypro_seed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_services ON master_services (tenant_id, master_id, service_id);
CREATE INDEX IF NOT EXISTS ix_master_services_svc ON master_services (tenant_id, service_id, active);
CREATE INDEX IF NOT EXISTS ix_master_services_mst ON master_services (tenant_id, master_id, active);

-- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['master_services'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON master_services TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE master_services_id_seq TO app_tenant;

COMMIT;
