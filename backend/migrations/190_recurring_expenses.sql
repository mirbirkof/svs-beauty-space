-- Постійні (програмовані) витрати: оренда, ЗП-фікс, підписки тощо.
-- При створенні витрати адмін може позначити її «Постійна (щомісяця)» — тоді вона
-- зберігається як шаблон тут і автоматично проводиться в касу кожного місяця.
-- «Разові» витрати йдуть напряму в cash_operations як і раніше (тут не зберігаються).

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id           SERIAL PRIMARY KEY,
  category     VARCHAR(60)  NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  method       VARCHAR(20)  DEFAULT 'cash',
  description  TEXT,
  day_of_month INT          DEFAULT 1,        -- день місяця для авто-проводки (1..28)
  active       BOOLEAN      DEFAULT TRUE,
  last_posted  DATE,                          -- перше число місяця, за який вже проведено
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recurring_exp_active ON recurring_expenses (active);
