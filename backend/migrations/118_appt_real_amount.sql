-- 118: реальна сума запису з фактичного продажу BeautyPro.
-- Проблема: appointments.price = ПЛАНОВА ціна з /appointments (напр. 1200).
-- Після оплати реальна сума (знижки/зміна послуги/доплати) лежить у cash_operations (/sales),
-- але в самий запис не підтягувалась — у картці висіла стара планова сума.
-- real_amount — фактично сплачено (сума сервісних продажів, що зматчились із записом).
-- price лишаємо як планову (для порівняння план/факт). UI показує real_amount, якщо є.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS real_amount   numeric;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS real_synced_at timestamptz;
