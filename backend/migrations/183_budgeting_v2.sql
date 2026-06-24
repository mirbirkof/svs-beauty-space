-- ═══════════════════════════════════════════════════════════════════════════
-- Міграція 183 — FIN-05 Budgeting v2
-- Додає: approval-workflow (submit/approve/reject), збережені сезонні пресети,
-- алерти 80%/100%, ALTER budgets (+approved_by/approved_at).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Доповнити budgets полями воркфлоу (якщо нема)
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS approved_by  TEXT;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;

-- 2. Журнал переходів статусів бюджету
CREATE TABLE IF NOT EXISTS budget_approval_log (
  id          SERIAL PRIMARY KEY,
  budget_id   INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  user_id     TEXT,
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_approval_log_budget ON budget_approval_log(budget_id, created_at);

-- 3. Сезонні пресети (збережені в БД, не тільки в коді)
CREATE TABLE IF NOT EXISTS budget_seasonal_presets (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  is_system  BOOLEAN NOT NULL DEFAULT false,
  factors    JSONB NOT NULL,  -- {"01":0.7,"02":0.85,...,"12":1.4}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seasonal_presets_id ON budget_seasonal_presets(id);

-- Системний пресет «Салон краси стандарт»
INSERT INTO budget_seasonal_presets (name, is_system, factors) VALUES
  ('Салон краси стандарт', true,
   '{"01":0.70,"02":0.85,"03":1.30,"04":1.05,"05":1.10,"06":0.95,"07":0.80,"08":0.85,"09":1.15,"10":1.05,"11":1.10,"12":1.40}')
ON CONFLICT DO NOTHING;

-- 4. Алерти перевищення бюджету
CREATE TABLE IF NOT EXISTS budget_alerts (
  id                SERIAL PRIMARY KEY,
  budget_id         INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id       INTEGER NOT NULL REFERENCES budget_categories(id),
  month             DATE NOT NULL,
  alert_type        TEXT NOT NULL,          -- warning (80%) | critical (100%)
  threshold_percent NUMERIC(5,2) NOT NULL,
  actual_percent    NUMERIC(5,2) NOT NULL,
  plan_amount       NUMERIC(14,2) NOT NULL,
  actual_amount     NUMERIC(14,2) NOT NULL,
  is_read           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_budget  ON budget_alerts(budget_id, month);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_unread  ON budget_alerts(is_read) WHERE NOT is_read;
