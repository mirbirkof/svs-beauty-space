-- 297: Журнал входов в смену (shift_login_audit) был мёртв с рождения.
--
-- ПРИЧИНА (аудит 19.08.2026): миграция 287 создала таблицу БЕЗ tenant_id и БЕЗ политики,
-- а RLS на ней включён скопом. Роль app_tenant (без BYPASSRLS) получала
-- "new row violates row-level security policy" на КАЖДОЙ вставке — 404 ошибки в логе,
-- в таблице 0 строк за всё время. Контроль «кто работал в чью смену» не работал вовсе.
--
-- ФИКС: тот же паттерн, что у всех tenant-таблиц (294_store_cash и др.).

ALTER TABLE shift_login_audit
  ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT current_tenant_id();

CREATE INDEX IF NOT EXISTS idx_shift_audit_tenant ON shift_login_audit(tenant_id, work_date DESC);

ALTER TABLE shift_login_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_login_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shift_login_audit;
CREATE POLICY tenant_isolation ON shift_login_audit
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
