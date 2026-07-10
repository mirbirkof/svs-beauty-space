-- 235_rls_close_all_tenant_tables.sql
-- ПРЕСЕЙЛ-БЛОКЕР #2: закрыть RLS на ВСЕХ таблицах с tenant_id.
--
-- Проблема: миграция 229 работала по СТАТИЧЕСКОМУ списку имён и вдобавок
-- ПРОПУСКАЛА таблицу, если у неё «уже есть колонка tenant_id» (skip-by-column).
-- Итог — после июльского фейловера на backup-БД 69 таблиц с tenant_id остались
-- БЕЗ ENABLE/FORCE RLS и без политики: второй салон мог читать чужие данные.
--
-- Решение: ДИНАМИЧЕСКИЙ проход по системному каталогу. Для КАЖДОЙ base-таблицы
-- public с колонкой tenant_id типа uuid — включаем ENABLE+FORCE ROW LEVEL SECURITY
-- и (пере)создаём политику tenant_isolation. Идемпотентно (DROP POLICY IF EXISTS
-- + CREATE), безопасно к повторному прогону и к новым таблицам.
--
-- Семантика политики идентична 015/222/229: fail-closed при заданном GUC
-- app.tenant_id, permissive без него (кроны/скрипты без контекста видят все строки).
-- FORCE обязателен: коннект миграций/приложения может идти под BYPASSRLS-владельцем.

DO $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema
       AND tb.table_name  = c.table_name
       AND tb.table_type  = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND c.data_type    = 'uuid'
       AND c.table_name NOT IN ('_migrations')
     ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '235: tenant_isolation применён к % таблицам с tenant_id', n;
END $$;
