-- Звірка каси: реальний залишок розділяємо на готівку і безготівку (фідбек Власника #142).
-- cash_fact лишається сумою (готівка + безготівка) для сумісності зі старим кодом і розрахунком розбіжності.
ALTER TABLE shift_checklists ADD COLUMN IF NOT EXISTS cash_fact_cash     NUMERIC(12,2); -- реально готівкою в касі
ALTER TABLE shift_checklists ADD COLUMN IF NOT EXISTS cash_fact_cashless NUMERIC(12,2); -- реально безготівкою (термінал)
