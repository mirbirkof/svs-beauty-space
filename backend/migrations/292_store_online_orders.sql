-- 292_store_online_orders.sql — SLS-11 этап 4: связь онлайн-заказа витрины с продажей магазина.
-- Нужна, чтобы при отмене/возврате товар вернулся на ТОТ склад, который его выдал.

ALTER TABLE store_sales ADD COLUMN IF NOT EXISTS order_id INTEGER;
ALTER TABLE store_sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','cancelled'));
CREATE INDEX IF NOT EXISTS idx_store_sales_order ON store_sales(order_id) WHERE order_id IS NOT NULL;

-- tenant_id + RLS для новых колонок не нужны (таблица уже закрыта миграцией 291),
-- но фиксируем правило: любая НОВАЯ таблица проекта обязана иметь tenant_id + tenant_isolation.
