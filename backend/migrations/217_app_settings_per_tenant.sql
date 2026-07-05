-- app_settings стають PER-TENANT (SaaS-аудит 06.07).
-- Раніше таблиця була платформенним синглтоном (PK key): другий салон бачив і
-- перезаписував налаштування Босса (masters_see_phone, require_open_shift,
-- solo_master_mode, модулі). Тепер (tenant_id, key) + RLS як у ядра.
-- Існуючі рядки лишаються у салона Босса через DEFAULT current_tenant_id().
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();
CREATE INDEX IF NOT EXISTS idx_app_settings_tenant ON app_settings (tenant_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_pkey'
               AND conrelid = 'app_settings'::regclass
               AND (SELECT COUNT(*) FROM unnest(conkey)) = 1) THEN
    ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
    ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
  END IF;
END $$;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_settings;
CREATE POLICY tenant_isolation ON app_settings
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
