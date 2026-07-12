-- 250: sales_part + kpi_bonus в GENERATED-формулу total (блокер аудита v8).
-- Было: total = percent_part + fixed_part + bonus - deduction — комиссия с продаж
-- (sales_part) и KPI-бонус в итог НЕ входили, мастер их не получал.
-- Postgres не умеет ALTER выражения generated-колонки → пересоздаём (0 строк, вью нет).
-- COALESCE обязателен: sales_part DEFAULT NULL, иначе весь total стал бы NULL.

ALTER TABLE payroll_records DROP COLUMN IF EXISTS total;
ALTER TABLE payroll_records ADD COLUMN total NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(percent_part,0) + COALESCE(fixed_part,0) + COALESCE(sales_part,0)
    + COALESCE(kpi_bonus,0) + COALESCE(bonus,0) - COALESCE(deduction,0)
  ) STORED;
