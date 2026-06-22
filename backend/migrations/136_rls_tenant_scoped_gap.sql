-- 136: закрытие пробела RLS на таблицах, созданных ПОСЛЕ массовых миграций 015/126.
--
-- Контекст (аудит безопасности 22.06): 31 таблица имеет колонку tenant_id, но RLS
-- на них не включён. До перевода прода на роль app_tenant (NOBYPASSRLS) это не текло
-- только потому, что база коннектилась владельцем (BYPASSRLS). Под app_tenant и при
-- появлении второго салона эти таблицы читались бы между тенантами.
--
-- Делим строго:
--   • ПРИВАТНЫЕ ДАННЫЕ САЛОНА  → RLS обязателен (Instagram-переписка, ключи API,
--     финансы салона, формы, портфолио, склад, уведомления, вебхуки, сегменты).
--   • ПЛАТФОРМЕННЫЕ (оператор видит ВСЕ салоны: биллинг SaaS, лицензии, онбординг,
--     health-чеки, тикеты, журнал событий, домены-роутинг) → RLS НЕ вешаем, иначе
--     супер-админка оператора (контекст DEFAULT_TENANT) перестанет видеть чужие
--     салоны. Эти таблицы защищены явными WHERE tenant_id=current_tenant_id() в роутах.
--
-- Политика идентична 015/126: при заданном GUC app.tenant_id фильтрует по тенанту
-- (fail-closed), без GUC (кроны/скрипты) — permissive. FORCE: владелец таблиц обходит
-- политику без него.

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    -- Instagram / омниканальность — приватная переписка клиентов салона
    'omni_channels','omni_conversations','omni_messages',
    -- ключи доступа салона
    'api_keys',
    -- финансы салона
    'bank_transactions','fiscal_receipts','payment_methods','fin_providers',
    -- контент и формы салона
    'portfolio_items','forms','form_submissions',
    -- маркетинг салона
    'campaigns','segments','marketing_triggers',
    -- склад салона
    'salon_stock',
    -- уведомления салона
    'notifications','notification_settings','notification_templates',
    -- репутация и вебхуки салона
    'reputation_settings','webhooks'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    -- защита от ошибки: вешаем политику только если колонка tenant_id реально есть
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='tenant_id'
    ) THEN
      RAISE NOTICE 'skip % — нет колонки tenant_id', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
    RAISE NOTICE 'RLS включён: %', t;
  END LOOP;
END $$;
