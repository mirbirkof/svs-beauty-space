-- 141: глобальный каталог ролей (аудит 23.06, Critical SaaS #1)
--
-- Проблема: миграция 015 повесила tenant_isolation на ВСЕ таблицы, включая roles.
-- roles.tenant_id = DEFAULT tenant#1, строк всего 9 (общий каталог ролей продукта).
-- При входе пользователя НОВОГО тенанта GUC app.tenant_id = его tenant → политика
-- фильтрует roles по tenant_id и возвращает 0 строк → JOIN users→roles даёт NULL →
-- пользователь входит БЕЗ прав (role_permissions = NULL). SaaS-онбординг сломан.
--
-- Решение: roles — это ПЛАТФОРМЕННЫЙ справочник (одинаковые роли для всех салонов),
-- а не приватные данные салона. Делаем чтение глобальным (permissive), записи
-- по-прежнему идут только через admin-роуты под ADMIN_TOKEN.
--
-- Идемпотентно: пересоздаём политику. FORCE оставляем — на случай если когда-то
-- понадобится точечно ограничить, но USING(true) делает каталог общим для всех.

DO $$
BEGIN
  IF to_regclass('public.roles') IS NULL THEN
    RAISE NOTICE 'roles нет — пропуск';
    RETURN;
  END IF;

  -- читать каталог ролей может любой тенант; писать — только под ADMIN_TOKEN в роутах
  EXECUTE 'ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.roles FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.roles';
  EXECUTE 'DROP POLICY IF EXISTS roles_global_catalog ON public.roles';
  EXECUTE 'CREATE POLICY roles_global_catalog ON public.roles USING (true) WITH CHECK (true)';
  RAISE NOTICE 'roles переведён в глобальный каталог (доступен всем тенантам)';
END $$;
