-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ FIN-05 (15.06) — Бюджетування
-- Планування доходів/витрат по періодах (місяць/квартал/рік),
-- статті по категоріях × місяцях, сезонні коефіцієнти,
-- план/факт із реальних даних каси (cash_operations + orders).
-- Прагматично для 1 салону: без мульти-філій/консолідації,
-- спрощений workflow (draft→active→closed), пресет сезонності в коді.
-- Факт рахується на льоту — окрема таблиця budget_actuals не потрібна.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS budget_categories (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,                 -- revenue | expense
  code              TEXT NOT NULL UNIQUE,
  cashbox_categories TEXT[] DEFAULT '{}',          -- мапінг на cash_operations.category
  sort_order        INTEGER DEFAULT 0,
  is_system         BOOLEAN DEFAULT false,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  period_type        TEXT NOT NULL DEFAULT 'month', -- month | quarter | year
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft',  -- draft | active | closed | archived
  total_revenue_plan NUMERIC(14,2) DEFAULT 0,
  total_expense_plan NUMERIC(14,2) DEFAULT 0,
  source_budget_id   INTEGER REFERENCES budgets(id),
  created_by         TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_budgets_period ON budgets(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_budgets_status ON budgets(status);

CREATE TABLE IF NOT EXISTS budget_items (
  id              SERIAL PRIMARY KEY,
  budget_id       INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id     INTEGER NOT NULL REFERENCES budget_categories(id),
  month           DATE NOT NULL,                  -- перший день місяця
  plan_amount     NUMERIC(14,2) DEFAULT 0,
  seasonal_factor NUMERIC(5,3) DEFAULT 1.000,
  base_amount     NUMERIC(14,2),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (budget_id, category_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_items_budget ON budget_items(budget_id, month);

-- ── Пресет-категорії (системні) ──
INSERT INTO budget_categories (name, type, code, cashbox_categories, sort_order, is_system) VALUES
  ('Послуги',      'revenue', 'services',     '{sale_service}',  10, true),
  ('Товари',       'revenue', 'products',     '{sale_product}',  20, true),
  ('Сертифікати',  'revenue', 'certificates', '{}',              30, true),
  ('Абонементи',   'revenue', 'subscriptions','{}',              40, true),
  ('Зарплата',     'expense', 'payroll',      '{salary}',        10, true),
  ('Оренда',       'expense', 'rent',         '{rent}',          20, true),
  ('Закупівлі',    'expense', 'purchases',    '{purchase,supply}', 30, true),
  ('Маркетинг',    'expense', 'marketing',    '{marketing,ads}', 40, true),
  ('Комуналка',    'expense', 'utilities',    '{utilities,communal}', 50, true),
  ('Інше',         'expense', 'other',        '{other,misc}',    60, true)
ON CONFLICT (code) DO NOTHING;
