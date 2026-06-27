-- FIN-04 Financial Center: снапшоти (предрозрахунок), віджети дашборду, експорти.
-- Single-salon (без tenant_id) — у тон financial.js/financial_digest_settings.

-- Предрозраховані знімки для миттєвого завантаження дашборду
CREATE TABLE IF NOT EXISTS financial_snapshots (
  id           SERIAL PRIMARY KEY,
  period_type  VARCHAR(10) NOT NULL,            -- daily | weekly | monthly
  period_date  DATE        NOT NULL,            -- дата початку періоду
  data         JSONB       NOT NULL,            -- результат snapshot(): revenue/expenses/profit/metrics
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_type, period_date)
);
CREATE INDEX IF NOT EXISTS idx_fin_snap_period ON financial_snapshots (period_type, period_date DESC);

-- Налаштовувані віджети дашборду (по користувачу)
CREATE TABLE IF NOT EXISTS financial_widgets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NULL,                 -- NULL = загальний (для всіх)
  widget_type VARCHAR(50) NOT NULL,             -- revenue_today|expense_breakdown|profit_trend|kpi_card|top_masters|category_pie
  title       VARCHAR(120) NULL,
  config      JSONB       NOT NULL DEFAULT '{}',
  position    INTEGER     NOT NULL DEFAULT 0,
  is_visible  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fin_widgets_user ON financial_widgets (user_id, position);

-- Експорти дашборду/віджетів у Excel/PDF + розшарені посилання
CREATE TABLE IF NOT EXISTS financial_exports (
  id           SERIAL PRIMARY KEY,
  scope        VARCHAR(30) NOT NULL,            -- full_dashboard | widget | custom_report
  format       VARCHAR(10) NOT NULL DEFAULT 'xlsx', -- xlsx | pdf | csv | json
  params       JSONB       NOT NULL DEFAULT '{}',
  status       VARCHAR(12) NOT NULL DEFAULT 'ready', -- pending | ready | failed
  payload      JSONB       NULL,                -- згенерований зміст (для миттєвого single-salon експорту)
  share_token  VARCHAR(40) NULL UNIQUE,
  shared_until TIMESTAMPTZ NULL,
  created_by   INTEGER     NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fin_exports_token ON financial_exports (share_token) WHERE share_token IS NOT NULL;
