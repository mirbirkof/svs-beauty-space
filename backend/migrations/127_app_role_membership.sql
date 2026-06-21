-- ═══════════════════════════════════════════════════════════════
-- 127 — Членство роли app_tenant для владельца БД (root-fix утечки тенантов)
--
-- Контекст (21.06): прод-приложение коннектится ролью neondb_owner, у которой
-- атрибут BYPASSRLS=on. Такая роль ИГНОРИРУЕТ все RLS-политики (миграции 015/126),
-- поэтому новый салон через авторизованное API видел клиентов/услуги/мастеров
-- соседнего салона — несмотря на корректно настроенные политики.
--
-- Фикс: приложение внутри каждой тенант-транзакции выполняет `SET LOCAL ROLE
-- app_tenant` (роль БЕЗ BYPASSRLS) — см. db-pg.js. Чтобы владелец БД мог
-- переключаться в эту роль, ему нужно членство в ней. Эта миграция его выдаёт.
--
-- Идемпотентна и не зависит от конкретного имени владельца (берёт current_user).
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE format('GRANT app_tenant TO %I', current_user);
    RAISE NOTICE 'app_tenant granted to %', current_user;
  ELSE
    RAISE NOTICE 'role app_tenant not found — skipping membership grant';
  END IF;
END $$;
