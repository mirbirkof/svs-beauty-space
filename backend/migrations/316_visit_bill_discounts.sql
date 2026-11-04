-- 04.11 (Босс): рахунок візиту = послуги + товари − знижки − сертифікат − бонуси − передоплата.
-- Незалежні знижки: «на послуги», «на товари», «на весь чек» (кожна % або грн).
-- Старий discount_amount лишається ПІДСУМКОМ усіх трьох. Старі візити: нові колонки NULL →
-- рахуються рівно як раніше (стара знижка = «на весь чек», пропорційна).
-- bill_sub_amount/bill_prepaid_amount — скільки покрили абонемент і передоплата (для перерахунку
-- оплаченого візиту при зміні товарів/ціни). bill_sent_at — коли бот надіслав клієнту рахунок.
-- Лише ADD COLUMN; наявні дані не змінюються. Ідемпотентна.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_svc_type TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_svc_value NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_services_amount NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_prod_type TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_prod_value NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_products_amount NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_check_type TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS disc_check_value NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_check_amount NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_services_total NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_products_total NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_sub_amount NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_prepaid_amount NUMERIC(12,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_sent_at TIMESTAMPTZ;
