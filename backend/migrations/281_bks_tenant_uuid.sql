-- Migration 281: branch_kpi_snapshots.tenant_id INTEGER → UUID (SaaS-ізоляція)
--
-- ПРОБЛЕМА (знайдено сторожем ізоляції ops/tenant-isolation-check.js, 26.07):
-- у міграції 182 колонку створили як INTEGER NOT NULL DEFAULT 1, тоді як у всій
-- системі tenant_id — UUID. Наслідки, усі три тихі:
--   1) self-healing RLS (lib/ensure-rls.js) шукає колонки типу uuid → таблиця
--      лишалась БЕЗ політики tenant_isolation, тобто без ізоляції орендарів;
--   2) purge салона (lib/tenant-mgmt.js) видаляє рядки лише по uuid-колонках →
--      дані видаленого салона лишались би тут назавжди (GDPR-ризик);
--   3) усі салони писали б DEFAULT 1 — снапшоти KPI змішались би в одну купу.
--
-- БЕЗПЕЧНО: таблиця порожня (0 рядків на момент міграції), у коді немає жодного
-- запиту до неї — фіча KPI-снапшотів ще не увімкнена. Тому просто перестворюємо
-- колонку з правильним типом; втрачати нічого.

ALTER TABLE branch_kpi_snapshots DROP CONSTRAINT IF EXISTS branch_kpi_snapshots_tenant_id_branch_id_period_type_period__key;
DROP INDEX IF EXISTS ix_bks_tenant_branch;
DROP INDEX IF EXISTS ix_bks_period;

ALTER TABLE branch_kpi_snapshots
  ALTER COLUMN tenant_id DROP DEFAULT,
  ALTER COLUMN tenant_id TYPE UUID USING '00000000-0000-0000-0000-000000000001'::uuid,
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bks_tenant_branch_period
  ON branch_kpi_snapshots (tenant_id, branch_id, period_type, period_start);
CREATE INDEX IF NOT EXISTS ix_bks_tenant_branch ON branch_kpi_snapshots (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS ix_bks_period ON branch_kpi_snapshots (tenant_id, period_type, period_start);

-- Політику tenant_isolation створить lib/ensure-rls.js на найближчому старті сервісу
-- (тепер колонка uuid → таблиця потрапляє під його динамічний ассерт).
