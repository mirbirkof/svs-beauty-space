-- ═══════════════════════════════════════════════════════════════
-- 126 — Закрытие пробела мультитенантной изоляции
--
-- Контекст: таблицы, добавленные ПОСЛЕ базовой настройки изоляции
-- (миграции 014/015), не получили колонку tenant_id и RLS-политику.
-- Аудит 21.06 выявил 44 бизнес-таблицы салона без изоляции:
-- сертификаты, прайс/комбо услуг, кабинеты, бюджеты, банк.счета,
-- зарплаты, закупки, абонементы, теги клиентов, графики смен и т.д.
--
-- Все текущие данные принадлежат единственному боевому салону
-- (tenant 00000000-0000-0000-0000-000000000001), тестовые тенанты
-- бизнес-данных не содержат → backfill через DEFAULT current_tenant_id()
-- (на момент миграции app.tenant_id не задан → вернёт дефолтный 001).
--
-- Шаблон 1:1 как у ядра (миграция 015): ENABLE+FORCE RLS,
-- политика tenant_isolation. Кроны/скрипты без app.tenant_id видят всё
-- (COALESCE → tenant_id = tenant_id), как и для остальных таблиц.
--
-- ПЛАТФОРМЕННЫЕ таблицы НЕ трогаем (saas_plans, promo_codes_saas,
-- dunning_attempts, feature_flags, dns/ssl/sla/health/uptime,
-- app_settings, ai_agent_tools, theme_presets, alert_*, ticket_replies,
-- webhook_deliveries) — они общие для платформы, изоляция им вредна.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'account_transfers','bank_accounts','payment_calendar',
    'auto_purchase_rules','purchase_orders','purchase_order_items',
    'purchase_approvals','purchase_receipts','purchase_receipt_items',
    'budgets','budget_categories','budget_items',
    'client_tags','client_tag_defs','financial_digest_settings',
    'gift_certificates','gift_certificate_transactions',
    'master_bp_aliases','master_schedule_days','staff_shifts','time_blocks',
    'notification_prefs',
    'payroll_advances','payroll_bonuses','payroll_payments','payroll_penalties',
    'review_request_log','rooms','salon_product_sales','segment_members',
    'service_categories','service_combos','service_combo_items',
    'service_consumables','service_master_prices','service_price_history',
    'service_variations',
    'subscription_freezes','subscription_usage','subscription_users',
    'subscriptions','subscription_plans',
    'booking_settings','booking_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    -- пропускаем, если таблицы нет в этой БД
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skip % (no such table)', t;
      CONTINUE;
    END IF;

    -- 1) колонка tenant_id с дефолтом как у ядра (backfill существующих → 001)
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id()',
      t
    );

    -- 2) индекс по tenant_id (для производительности фильтрации)
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
      'idx_' || t || '_tenant', t
    );

    -- 3) включаем RLS (+FORCE, чтобы владелец тоже подчинялся)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    -- 4) политика изоляции (идемпотентно)
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );

    RAISE NOTICE 'isolated %', t;
  END LOOP;
END $$;
