-- 227: изоляция DWH (хранилище аналитики) по тенанту (предпродажный аудит 07.07.2026).
-- fact/dim/etl таблицы DWH создавались без tenant_id (routes/data-warehouse.js:37
-- честно помечал «ещё БЕЗ tenant_id»). Второй салон видел бы агрегированный оборот,
-- клиентскую базу, платежи и визиты первого. Закрываем все DWH-таблицы разом.
-- Паттерн идентичен 222/226. dwh_etl_runs и dwh_fact_visits уже изолированы — пропустятся.

DO $$
DECLARE
  t TEXT;
  tabs TEXT[] := ARRAY[
    'dwh_data_sources','dwh_dim_clients','dwh_dim_products','dwh_dim_services',
    'dwh_dim_staff','dwh_dim_time','dwh_etl_jobs','dwh_etl_logs',
    'dwh_fact_payments','dwh_fact_sales','dwh_fact_staff_payroll','dwh_fact_visits_v2'
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    -- 1. tenant_id (DEFAULT backfill'ит существующие строки в тенanta Босса)
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id()', t);
    -- 2. RLS
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
    -- 3. индекс под фильтр
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_tenant ON public.%I(tenant_id)', t, t);
  END LOOP;
END $$;
