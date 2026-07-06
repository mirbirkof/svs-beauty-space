-- 222: закрытие пробела изоляции v3 (аудит 06.07.2026).
-- Всё, что создано после gap-close 136 (миграции 153–219), выпало из процесса
-- «новая таблица → tenant_id + RLS». Здесь: добавляем tenant_id (DEFAULT
-- current_tenant_id() — подхватывает активного тенанта из GUC), backfill где
-- можно вывести из родителя, включаем RLS (политика идентична 015/126/136),
-- пересобираем глобальные UNIQUE в UNIQUE(tenant_id, ...).
--
-- Критичное: shift_checklists.UNIQUE(work_date) — второй салон, закрывая смену,
-- ПЕРЕЗАПИСЫВАЛ бы чек-лист и суммы кассы первого. expense_confirmations.UNIQUE(ref_key)
-- — аналогичный глобальный конфликт подтверждений ЗП.

-- ── 1. tenant_id на таблицы, где его нет ──
DO $$
DECLARE
  t TEXT;
  tabs TEXT[] := ARRAY[
    'shift_checklists','expense_confirmations','recurring_expenses',
    'salon_zones','zone_masters',
    'material_norms','procedure_materials',
    'kpi_targets','kpi_facts','kpi_badges',
    'visit_stage_log','appointment_materials'
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id()', t);
  END LOOP;
END $$;

-- backfill из родителя (данные существующего салона и так дефолтные, но связка надёжнее)
UPDATE appointment_materials am SET tenant_id = a.tenant_id
  FROM appointments a WHERE a.id = am.appointment_id AND am.tenant_id <> a.tenant_id;

-- ── 2. RLS (fail-closed при заданном GUC, permissive без него — кроны/скрипты) ──
DO $$
DECLARE
  t TEXT;
  tabs TEXT[] := ARRAY[
    'shift_checklists','expense_confirmations','recurring_expenses',
    'salon_zones','zone_masters',
    'material_norms','procedure_materials',
    'kpi_targets','kpi_facts','kpi_badges',
    'visit_stage_log','appointment_materials'
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=t AND column_name='tenant_id') THEN
      RAISE NOTICE 'skip % — нет tenant_id', t; CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;

-- ── 3. глобальные UNIQUE → per-tenant ──
ALTER TABLE shift_checklists DROP CONSTRAINT IF EXISTS shift_checklists_work_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_checklists_tenant_date
  ON shift_checklists (tenant_id, work_date);

ALTER TABLE expense_confirmations DROP CONSTRAINT IF EXISTS expense_confirmations_ref_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_confirm_tenant_refkey
  ON expense_confirmations (tenant_id, ref_key);
