-- 015: RLS-изоляция тенантов (SAS-01, этап 2)
--
-- Принцип: безопасность на уровне БД, а не на совести каждого роута.
-- HTTP-запрос ставит GUC app.tenant_id (transaction-local) → Postgres сам
-- фильтрует строки. Роуты НЕ требуют правок.
--
-- Поведение:
--   GUC установлен  → видны/пишутся ТОЛЬКО строки своего тенанта (fail-closed)
--   GUC не задан    → permissive: видны все строки (кроны, скрипты, миграции)
--
-- FORCE обязателен: подключение идёт владельцем таблиц (Neon), без FORCE
-- владелец обходит политики.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('_migrations', 'tenants')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))
         WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
  END LOOP;
END $$;

-- tenants: суперадмин-операции идут без GUC (permissive), сам каталог тенантов
-- должен читаться при резолве slug ДО установки контекста — RLS не включаем.

-- ВАЖНО (выяснено 10.06.2026): neondb_owner имеет rolbypassrls=true — FORCE RLS
-- его НЕ останавливает, ALTER ROLE запрещён (managed Neon). Поэтому приложение
-- ходит ролью app_tenant (NOBYPASSRLS, DATABASE_URL_APP в .env), а миграции/DDL —
-- владельцем (DATABASE_URL). При создании новых таблиц права раздаются автоматически
-- (ALTER DEFAULT PRIVILEGES), но RLS-политику на новую таблицу надо вешать явно.
