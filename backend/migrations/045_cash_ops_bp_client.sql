-- ═══════════════════════════════════════════════════════
-- Точна привʼязка оплати до запису (журнал «оплачено» = правда)
-- Проблема: бейдж «оплачено» вішався по евристиці «продаж того ж
--   майстра у вікні ±4 год» → хибні спрацювання (booked-записи) і
--   пропуски. Для перевірок/аудиту дані мають бути 100% правдиві.
-- Рішення: зберігати GUID клієнта BeautyPro і дату продажу (calendar_date)
--   у касовій операції → матчимо продаж із записом по client+master+день.
-- ═══════════════════════════════════════════════════════
ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS bp_client   TEXT;        -- GUID клієнта BeautyPro з продажу
ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS bp_calendar TIMESTAMPTZ; -- calendar_date продажу (час запису у BP)

CREATE INDEX IF NOT EXISTS idx_cash_ops_bp_client ON cash_operations(bp_client) WHERE bp_client IS NOT NULL;
