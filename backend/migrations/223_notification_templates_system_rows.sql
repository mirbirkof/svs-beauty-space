-- 223: системні шаблони сповіщень (tenant_id IS NULL) мають бути ВИДИМІ всім тенантам.
-- Політика 136 (tenant_id = current) ховала NULL-рядки → у нового салону 0 шаблонів,
-- renderTemplate → null, підтвердження/нагадування мовчки не надсилались (аудит 06.07).
-- Читання: свої + системні. Запис: тільки свої (WITH CHECK без NULL).
DO $$
BEGIN
  IF to_regclass('public.notification_templates') IS NULL THEN RETURN; END IF;
  DROP POLICY IF EXISTS tenant_isolation ON public.notification_templates;
  CREATE POLICY tenant_isolation ON public.notification_templates
    USING (tenant_id IS NULL
           OR tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
END $$;
