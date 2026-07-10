-- 240_platform_managed_tables_rls_off.sql
-- E2E-аудит «второй салон» 10.07: регресс миграции 235 (пресейл-блокер #2).
--
-- 235 динамически повесила tenant_isolation на ВСЕ таблицы с tenant_id uuid,
-- включая ПЛАТФОРМЕННО-управляемые (дизайн lib/tenant-mgmt.js, шапка: «таблицы
-- без RLS — запросы фильтруют по tenant_id явно; для записи в чужой тенант
-- указываем tenant_id»). Итог: public-signup работал в GUC-контексте дефолтного
-- тенанта и НЕ мог создать строки для нового салона:
--   - subscriptions_saas → «new row violates RLS» → подписка не создавалась
--   - licenses           → онлайн-запись не активировалась (booking/init 403)
--   - tenant_onboarding  → шаги онбординга молча терялись
-- А staff_otp_throttle (глобальный анти-brute-force, PK по key, ключи pwd:ip:*
-- ОБЩИЕ для всех салонов) с per-tenant политикой валил login-password 500:
-- upsert ON CONFLICT(key) попадал в невидимую строку чужого тенанта.
--
-- Решение: снять RLS с платформенно-управляемых таблиц (изоляция — явными
-- WHERE tenant_id=$1, как задумано). Синхронно с исключениями в lib/ensure-rls.js
-- (иначе boot-time самопочинка вернула бы политики при каждом старте).
-- Также снят RLS с 55 платформенных таблиц БЕЗ tenant_id (артефакт переезда на
-- Supabase: RLS был включён на всех 411 таблицах без политик → default-deny;
-- на эталонной Neon-БД у них RLS выключен) — это делает блок DO ниже.

DO $$
DECLARE
  t TEXT;
BEGIN
  -- 1) Платформенно-управляемые таблицы с tenant_id: политика долой, RLS off.
  FOREACH t IN ARRAY ARRAY['subscriptions_saas','invoices_saas',
    'tenant_addon_subscriptions','licenses','tenant_onboarding','staff_otp_throttle']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;

  -- 2) Платформенные таблицы БЕЗ tenant_id, у которых RLS включён, а политик нет
  --    (default-deny для app_tenant — ломает платформенные операции): RLS off.
  FOR t IN
    SELECT cl.relname
      FROM pg_class cl
     WHERE cl.relnamespace = 'public'::regnamespace
       AND cl.relkind = 'r'
       AND cl.relrowsecurity = true
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = cl.oid)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                        WHERE ic.table_schema = 'public'
                          AND ic.table_name = cl.relname
                          AND ic.column_name = 'tenant_id')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
