-- 258: номер абонемента — per-tenant (контрольный аудит, регресс класса «глобальный UNIQUE»).
-- subscription_number имел ГЛОБАЛЬНЫЙ UNIQUE (миграция 057): второй салон при продаже своего
-- первого абонемента получал 'SUB-2026-0001', ловил конфликт с абонементом первого салона → 500.
-- Тот же класс, что уже закрыт для PO (255), счетов (254), specializations/kpi (252) — подписки
-- пропущены. Нумерация у каждого салона своя (genNumber под RLS считает только свои строки).
BEGIN;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_subscription_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_tenant_number ON subscriptions (tenant_id, subscription_number);
COMMIT;
