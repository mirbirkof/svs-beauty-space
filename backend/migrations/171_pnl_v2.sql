-- 171: FIN-07 P&L (Profit & Loss / Звіт про прибутки та збитки).
-- Автоматичний P&L поверх існуючих фінансових/операційних модулів
-- (cash_operations, orders, appointments, payroll_records, stock_movements,
--  gift_certificate_transactions, subscriptions). Первинні дані НЕ дублюються —
-- тут лише: збережені знімки звітів (pnl_reports + pnl_line_items), конфіг
-- структури (pnl_config) та ручні коригування (pnl_adjustments).
-- Integer SERIAL модель + branch_id INTEGER (як решта single-salon таблиць,
-- branches.id = SERIAL, а не UUID зі специфікації). Усе IF NOT EXISTS — ідемпотентно.
BEGIN;

-- ── 171.1 Збережені звіти P&L (знімки за період) ─────────────────────────────
CREATE TABLE IF NOT EXISTS pnl_reports (
  id             SERIAL        PRIMARY KEY,
  branch_id      INTEGER,                              -- NULL = консолідація (усі філії)
  period_type    VARCHAR(10)   NOT NULL DEFAULT 'month', -- month|quarter|year|custom
  period_start   DATE          NOT NULL,
  period_end     DATE          NOT NULL,
  total_revenue  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cogs     NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_profit   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_opex     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ebitda         NUMERIC(12,2) NOT NULL DEFAULT 0,
  depreciation   NUMERIC(12,2) NOT NULL DEFAULT 0,
  interest       NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxes          NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_profit     NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_margin   NUMERIC(6,2)  NOT NULL DEFAULT 0,     -- %
  net_margin     NUMERIC(6,2)  NOT NULL DEFAULT 0,     -- %
  generated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (branch_id, period_type, period_start)
);
CREATE INDEX IF NOT EXISTS idx_pnl_reports_period ON pnl_reports (period_type, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_pnl_reports_branch ON pnl_reports (branch_id, period_start DESC);

-- ── 171.2 Рядки звіту (статті доходів/витрат) ────────────────────────────────
CREATE TABLE IF NOT EXISTS pnl_line_items (
  id                 SERIAL        PRIMARY KEY,
  report_id          INTEGER       NOT NULL REFERENCES pnl_reports(id) ON DELETE CASCADE,
  section            VARCHAR(20)   NOT NULL,           -- revenue|cogs|opex|other
  category           VARCHAR(50)   NOT NULL,           -- services_hair|products|rent|salary_piece|...
  label              VARCHAR(255)  NOT NULL,
  amount             NUMERIC(12,2) NOT NULL DEFAULT 0,
  budget_amount      NUMERIC(12,2),                    -- план (FIN-05)
  prev_period_amount NUMERIC(12,2),                    -- попередній період
  sort_order         INTEGER       NOT NULL DEFAULT 0,
  drilldown_query    JSONB,                            -- {source, category, ...} для деталізації
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pnl_line_items_report ON pnl_line_items (report_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pnl_line_items_section ON pnl_line_items (report_id, section);

-- ── 171.3 Конфіг структури P&L (мапа категорій → джерело) ────────────────────
CREATE TABLE IF NOT EXISTS pnl_config (
  id                SERIAL        PRIMARY KEY,
  branch_id         INTEGER,                           -- NULL = глобальний
  line_items_config JSONB         NOT NULL DEFAULT '[]'::jsonb,
  auto_generate     BOOLEAN       NOT NULL DEFAULT TRUE,
  auto_generate_day INTEGER       NOT NULL DEFAULT 1,  -- день місяця для автогенерації
  auto_send_to      INTEGER[]     DEFAULT '{}',        -- master_ids/user_ids для автоотправки
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (branch_id)
);

-- ── 171.4 Ручні коригування статей (амортизація, %, податки, поправки) ───────
-- Дозволяє додати в P&L те, чого нема в первинних даних (амортизація обладнання,
-- проценти по кредитах, нарахування податків) — без вигаданих цифр у звіті.
CREATE TABLE IF NOT EXISTS pnl_adjustments (
  id           SERIAL        PRIMARY KEY,
  branch_id    INTEGER,                                -- NULL = усі філії
  period_start DATE          NOT NULL,
  period_end   DATE          NOT NULL,
  section      VARCHAR(20)   NOT NULL DEFAULT 'opex',  -- revenue|cogs|opex|other
  category     VARCHAR(50)   NOT NULL,                 -- depreciation|interest|taxes|other
  label        VARCHAR(255)  NOT NULL,
  amount       NUMERIC(12,2) NOT NULL DEFAULT 0,       -- + збільшує витрати/дохід секції
  notes        TEXT,
  created_by   INTEGER,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pnl_adjustments_period ON pnl_adjustments (period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_pnl_adjustments_branch ON pnl_adjustments (branch_id, period_start);

-- ── 171.5 Дефолтний глобальний конфіг структури P&L ──────────────────────────
INSERT INTO pnl_config (branch_id, line_items_config, auto_generate, auto_generate_day)
VALUES (NULL, '[
  {"section":"revenue","category":"services","label":"Виручка від послуг","source":"cash_operations","sort_order":10},
  {"section":"revenue","category":"products","label":"Виручка від товарів","source":"orders+cash_operations","sort_order":20},
  {"section":"revenue","category":"certificates","label":"Виручка від сертифікатів","source":"gift_certificate_transactions","sort_order":30},
  {"section":"revenue","category":"subscriptions","label":"Виручка від абонементів","source":"subscriptions","sort_order":40},
  {"section":"revenue","category":"other_income","label":"Інші доходи","source":"cash_operations","sort_order":50},
  {"section":"cogs","category":"materials","label":"Розхідні матеріали","source":"stock_movements","sort_order":110},
  {"section":"cogs","category":"salary_piece","label":"Зарплата майстрів (відрядна)","source":"payroll_records","sort_order":120},
  {"section":"opex","category":"salary_fixed","label":"Зарплати (оклад + адмін)","source":"payroll_records","sort_order":210},
  {"section":"opex","category":"rent","label":"Оренда","source":"cash_operations","sort_order":220},
  {"section":"opex","category":"utilities","label":"Комунальні послуги","source":"cash_operations","sort_order":230},
  {"section":"opex","category":"marketing","label":"Маркетинг і реклама","source":"cash_operations","sort_order":240},
  {"section":"opex","category":"supplier","label":"Закупівлі","source":"cash_operations","sort_order":250},
  {"section":"opex","category":"other_out","label":"Інші операційні","source":"cash_operations","sort_order":260}
]'::jsonb, TRUE, 1)
ON CONFLICT (branch_id) DO NOTHING;

COMMIT;
