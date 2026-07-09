-- 234: відновити tenant_id-умовчання та критичні UNIQUE на будь-якій БД.
-- ПРИЧИНА (інцидент 09.07): після фейловера резервна БД будувалась neon-sync як
-- "контейнер даних" — без DEFAULT-ів і без inline-UNIQUE. Наслідок: 102 таблиці
-- втратили `tenant_id DEFAULT current_tenant_id()` → INSERT під app_tenant давав
-- tenant_id=NULL → RLS WITH CHECK відхиляв вставку ("new row violates RLS").
-- Симптом у власника: "адмін не може додати фарбу у візит". Насправді ламалась
-- вставка в БАГАТЬОХ таблицях. Ця міграція ідемпотентна й самолікує будь-яку БД.

-- 1) appointment_materials: відновити UNIQUE(appointment_id, variant_id) —
--    без нього ON CONFLICT у POST /api/consumables/appointment/:id падав.
DO $$
BEGIN
  IF to_regclass('public.appointment_materials') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.appointment_materials'::regclass AND contype = 'u'
          AND conkey @> ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid='public.appointment_materials'::regclass AND attname='appointment_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid='public.appointment_materials'::regclass AND attname='variant_id')
          ]::smallint[])
  THEN
    BEGIN
      ALTER TABLE public.appointment_materials
        ADD CONSTRAINT appointment_materials_appointment_id_variant_id_key UNIQUE (appointment_id, variant_id);
    EXCEPTION WHEN others THEN NULL; -- дублі/вже існує → пропускаємо
    END;
  END IF;
END $$;

-- 2) Відновити tenant_id DEFAULT current_tenant_id() на ВСІХ tenant-таблицях,
--    де воно втрачене. Пропускаємо tenant_id не-uuid типу (аналітичні знімки).
DO $$
DECLARE r record;
BEGIN
  IF to_regproc('current_tenant_id()') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name=c.table_name AND t.table_schema='public' AND t.table_type='BASE TABLE'
     WHERE c.column_name='tenant_id' AND c.table_schema='public'
       AND c.data_type='uuid' AND c.table_name<>'tenants'
       AND (c.column_default IS NULL OR c.column_default NOT LIKE '%current_tenant_id%')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()', r.table_name);
  END LOOP;
END $$;
