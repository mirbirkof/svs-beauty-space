-- 01.11.2026: постійні витрати (оренда, CRM…) проводяться в касу 1-го числа ЦІЛИМ місяцем — це правильно
-- для каси, але аналітика (Фінцентр, зали, P&L) за 1 день показувала -6837% маржі.
-- Тепер проводка постійної витрати НЕСЕ ПОЗНАЧКУ: на який шаблон (recurring_expense_id) і за який місяць
-- (accrual_month = 1-ше число). Аналітика розносить такі суми по днях місяця; каса/журнал/суми — без змін.
-- Додавальна, ідемпотентна. Нічого не видаляє і не змінює суми/дати. RLS cash_operations вже FORCE —
-- нові колонки його успадковують (нова таблиця не створюється).
ALTER TABLE cash_operations
  ADD COLUMN IF NOT EXISTS recurring_expense_id INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accrual_month DATE;

CREATE INDEX IF NOT EXISTS cash_operations_accrual_month_idx
  ON cash_operations (accrual_month) WHERE accrual_month IS NOT NULL;

-- Бекфіл уже проведених автопроводок: опис «<опис шаблону|Постійна витрата> (авто)» + та сама сума + той самий салон.
-- Якщо підходять кілька шаблонів — пріоритет тому, у якого збігається категорія. Місяць — київський місяць проводки.
WITH cand AS (
  SELECT DISTINCT ON (co.id) co.id AS op_id, re.id AS re_id,
         date_trunc('month', co.created_at AT TIME ZONE 'Europe/Kyiv')::date AS am
  FROM cash_operations co
  JOIN recurring_expenses re
    ON re.tenant_id = co.tenant_id
   AND co.description = COALESCE(NULLIF(re.description, ''), 'Постійна витрата') || ' (авто)'
   AND co.amount = re.amount
  WHERE co.type = 'out' AND co.accrual_month IS NULL AND co.shift_id IS NULL
  ORDER BY co.id, (lower(co.category) = lower(re.category)) DESC, re.id
)
UPDATE cash_operations co
   SET recurring_expense_id = cand.re_id, accrual_month = cand.am
  FROM cand
 WHERE co.id = cand.op_id;
