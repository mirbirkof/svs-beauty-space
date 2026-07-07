-- 229: закрытие пробела изоляции v4 (повторный аудit 07.07.2026, 20 экспертов).
-- Первый проход (226/227) закрыл stock_import + DWH, но аудит v2 нашёл ещё ~40 таблиц
-- бизнес-данных салона без tenant_id/RLS — прямая утечка и IDOR между салонами.
-- Самое критичное: client_notes/client_preferences (заметки о клиентах фильтровались
-- только по client_id → чужой салон видел заметки), financial_snapshots/pnl_* (финансы),
-- material_consumption_log (списания), payroll_* (зарплаты), room_* (кабинеты).
-- Паттерн идентичен 222/226/227: DEFAULT current_tenant_id() backfill'ит существующие
-- строки в тенант Босса (единственный реальный тенант сейчас), RLS-политика как 015/136.

DO $$
DECLARE
  t TEXT;
  tabs TEXT[] := ARRAY[
    -- клиенты (IDOR — критично)
    'client_notes','client_preferences','viber_subscribers',
    -- финансы салона
    'financial_snapshots','financial_widgets','financial_exports',
    'cash_flow_entries','bank_statement_imports',
    'pnl_reports','pnl_line_items','pnl_config','pnl_adjustments',
    'budget_alerts','budget_approval_log',
    -- кабинеты
    'room_schedules','room_equipment','room_blocks',
    -- склад/материалы
    'material_consumption_log',
    -- зарплаты и KPI
    'payroll_rules','payroll_recalc_log','payroll_partial_payments',
    'kpi_actuals','kpi_achievements','kpi_bonuses',
    -- персонал
    'employee_documents','employee_history','employee_specializations',
    -- подписки/биллинг тенанта
    'dunning_attempts','subscription_payments','subscription_adjustments',
    -- лояльность
    'gift_certificate_series',
    -- AI-данные тенанта
    'ai_recommendations','ai_recommendation_feedback','ai_sales_offers',
    'ai_insights','ai_forecasts','ai_predictions','ai_anomalies','ai_nl_queries',
    -- алерты тенанта
    'alert_history','alert_rules'
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skip % — нет таблицы', t; CONTINUE;
    END IF;
    -- уже изолирована? пропускаем
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=t AND column_name='tenant_id') THEN
      RAISE NOTICE 'skip % — tenant_id уже есть', t; CONTINUE;
    END IF;
    -- 1. tenant_id (DEFAULT backfill'ит существующие строки в тенант Босса)
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id uuid NOT NULL DEFAULT current_tenant_id()', t);
    -- 2. RLS (fail-closed при заданном GUC, permissive без него — кроны/скрипты)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
    -- 3. индекс под фильтр по тенанту
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_tenant ON public.%I(tenant_id)', t, t);
    RAISE NOTICE 'isolated %', t;
  END LOOP;
END $$;
