-- Підтвердження витрат: адмін підтверджує/коригує нараховані витрати (ЗП по майстрах,
-- постійні витрати) і вони проводяться в касу. Нагадування 1/15/кінець місяця.
-- ref_key робить підтвердження ідемпотентним (один раз на сутність+період).

CREATE TABLE IF NOT EXISTS expense_confirmations (
  id           SERIAL PRIMARY KEY,
  kind         VARCHAR(20) NOT NULL,        -- salary | recurring | other
  ref_key      TEXT        NOT NULL UNIQUE,  -- напр. 'salary:25:2026-06' | 'recurring:3:2026-06'
  period       VARCHAR(7)  NOT NULL,         -- YYYY-MM
  label        TEXT,                          -- людська назва (майстер/стаття)
  amount_calc  NUMERIC(12,2),                -- скільки нараховано системою
  amount_paid  NUMERIC(12,2),                -- скільки підтверджено/проведено
  cash_op_id   INTEGER,                       -- посилання на проведену касову операцію
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by VARCHAR(120)
);
CREATE INDEX IF NOT EXISTS idx_exp_confirm_period ON expense_confirmations (period);
