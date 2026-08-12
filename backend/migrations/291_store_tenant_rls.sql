-- 291_store_tenant_rls.sql — SLS-11 фикс: таблицы магазина в общий контур мультиарендности.
-- ПРИЧИНА (найдено боевым тестом 12.08): в БД есть event-trigger, который включает RLS
-- на каждой новой таблице. Таблицы 288-290 создавались без tenant_id → RLS включён,
-- политики нет → INSERT из приложения отбивался (store_counterparties), а чтение
-- дашборда возвращало нули. Лечим корень: tenant_id как у всех таблиц проекта + политика
-- tenant_isolation (эталон миграции 235).

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'warehouses','warehouse_stock',
    'store_receipts','store_receipt_items',
    'internal_transfers','internal_transfer_items',
    'store_counterparties','store_sales','store_sale_items','store_payments'
  ] LOOP
    -- 1) колонка тенанта с дефолтом текущего салона
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT current_tenant_id()', t);
    -- 2) RLS + политика изоляции (та же формула, что и у остальных таблиц)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;

-- Склады — общий справочник структуры (salon/store), одинаков для любого тенанта.
-- Уникальность id уже даёт PK; тенант проставляется дефолтом при вставке новых.
