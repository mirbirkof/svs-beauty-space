-- 034: План месяца на мастера.
-- Владелец/руководитель задаёт план по обороту на каждого специалиста.
-- Можно задать план на одну смену (plan_per_shift) — тогда общий план месяца
-- считается автоматически = plan_per_shift × количество смен мастера в месяце.
-- Либо задать общий план вручную (plan_total, auto_from_shifts=false).
-- Факт оборота, число смен и % выполнения считаются на лету в /api/reports.
BEGIN;

CREATE TABLE IF NOT EXISTS master_monthly_plans (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  master_id       INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL,
  month           INTEGER NOT NULL,                 -- 1..12
  plan_per_shift  NUMERIC(12,2) NOT NULL DEFAULT 0, -- план на одну смену
  plan_total      NUMERIC(12,2) NOT NULL DEFAULT 0, -- ручной общий план (если auto_from_shifts=false)
  auto_from_shifts BOOLEAN NOT NULL DEFAULT TRUE,   -- считать план = plan_per_shift × смены
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (master_id, year, month)
);

CREATE INDEX IF NOT EXISTS ix_mmp_period
  ON master_monthly_plans (year, month);

ALTER TABLE master_monthly_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_monthly_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_monthly_plans;
CREATE POLICY tenant_isolation ON master_monthly_plans
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON master_monthly_plans TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE master_monthly_plans_id_seq TO app_tenant;

COMMIT;
