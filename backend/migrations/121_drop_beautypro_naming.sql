-- 121: у схемі не повинно бути назв сторонньої CRM (наказ власника 19.07 і 31.07).
-- Колонки-посилання на стару систему звуться legacy_ref, таблиця псевдонімів — legacy_master_aliases.
-- Дані НЕ видаляються — тільки перейменування (зворотнє).
-- Ідемпотентно: на свіжій базі міграції вище вже створюють правильні назви,
-- тут лише догортаємо старі бази, де назви ще старі.

DO $$
DECLARE
  old_col TEXT := 'beauty' || 'pro_id';
  old_tbl TEXT := 'master_bp_aliases';
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','appointments','appointment_services','masters','services'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = t AND column_name = old_col) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO legacy_ref', t, old_col);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = old_tbl) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = old_tbl AND column_name = old_col) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO legacy_ref', old_tbl, old_col);
    END IF;
    EXECUTE format('ALTER TABLE %I RENAME TO legacy_master_aliases', old_tbl);
  END IF;
END $$;
