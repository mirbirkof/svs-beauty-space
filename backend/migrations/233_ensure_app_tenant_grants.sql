-- 233: гарантувати привілеї ролі app_tenant на ВСІ таблиці/послідовності/функції.
-- ПРИЧИНА (інцидент 09.07.2026): після фейловера на резервний Neon роль app_tenant
-- існувала, але БЕЗ GRANT на таблиці → кожен запит застосунку під `SET LOCAL ROLE
-- app_tenant` падав "permission denied" → у CRM усюди "internal", вхід блокувався.
-- Гранти в старих міграціях видавались ПОТАБЛИЧНО, тож нова/відновлена БД їх не мала.
-- ЦЯ міграція робить видачу централізованою та ідемпотентною — застосовується на будь-якій
-- БД при деплої (у т.ч. на щойно піднятому резерві). RLS усе одно фільтрує рядки по салону,
-- тож широкий GRANT безпечний: app_tenant НЕ обходить RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    GRANT USAGE ON SCHEMA public TO app_tenant;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_tenant;
    -- майбутні таблиці/послідовності (створені власником) — автоматично доступні app_tenant
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_tenant;
  END IF;
END $$;
