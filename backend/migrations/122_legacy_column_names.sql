-- 122: прибрати скорочення чужої CRM з назв колонок (наказ власника 02.08).
-- Тільки перейменування, дані не чіпаємо. Ідемпотентно: працює і на свіжій, і на старій базі.
-- УВАГА: таблиці gbp_* — це Google Business Profile, їх НЕ чіпаємо.

DO $$
DECLARE
  r RECORD;
  newname TEXT;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name LIKE 'bp\_%'
  LOOP
    newname := CASE r.column_name
      WHEN 'bp_client'         THEN 'legacy_client_ref'
      WHEN 'bp_calendar'       THEN 'legacy_calendar_ref'
      WHEN 'bp_state'          THEN 'legacy_state'
      WHEN 'bp_appointment_id' THEN 'legacy_appointment_ref'
      ELSE 'legacy_' || substring(r.column_name from 4)
    END;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=r.table_name AND column_name=newname) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.table_name, r.column_name, newname);
    END IF;
  END LOOP;

  -- Технічний кеш і резервні копії з назвою чужої CRM у назві.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='bp_cache') THEN
    EXECUTE 'ALTER TABLE bp_cache RENAME TO legacy_cache';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='cash_bpsale_backup_20260720') THEN
    EXECUTE 'ALTER TABLE cash_bpsale_backup_20260720 RENAME TO cash_sale_backup_20260720';
  END IF;
END $$;
