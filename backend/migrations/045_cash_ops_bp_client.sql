-- ═══════════════════════════════════════════════════════
-- Точна привʼязка оплати до запису (журнал «оплачено» = правда)
-- Проблема: бейдж «оплачено» вішався по евристиці «продаж того ж
--   майстра у вікні ±4 год» → хибні спрацювання (booked-записи) і
--   пропуски. Для перевірок/аудиту дані мають бути 100% правдиві.
-- Рішення: зберігати GUID клієнта стара CRM і дату продажу (calendar_date)
--   у касовій операції → матчимо продаж із записом по client+master+день.
-- ═══════════════════════════════════════════════════════
ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS legacy_client_ref   TEXT;        -- GUID клієнта стара CRM з продажу
ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS legacy_calendar_ref TIMESTAMPTZ; -- calendar_date продажу (час запису у BP)

CREATE INDEX IF NOT EXISTS idx_cash_ops_legacy_client_ref ON cash_operations(legacy_client_ref) WHERE legacy_client_ref IS NOT NULL;
