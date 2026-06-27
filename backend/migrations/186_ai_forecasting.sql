-- AI-08 Forecasting: реєстр моделей, збережені сценарії, кеш прогнозів.
-- Прагматична single-salon версія (serial id). Розрахунок — decomposition у forecasting.js.

CREATE TABLE IF NOT EXISTS ai_forecast_models (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(40) NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  type        VARCHAR(30) NOT NULL DEFAULT 'decomposition', -- decomposition | linear | seasonal_naive
  params      JSONB       NOT NULL DEFAULT '{}',
  metrics     JSONB       NULL,                 -- {mape, rmse, backtest_at}
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  trained_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_forecast_scenarios (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(120) NOT NULL,
  type             VARCHAR(30) NOT NULL,         -- price_change | discount | extra_master | custom
  params           JSONB       NOT NULL DEFAULT '{}',
  base_forecast_id INTEGER     NULL,
  result           JSONB       NULL,             -- результат останнього /calculate
  created_by       INTEGER     NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calculated_at    TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS ai_forecasts (
  id           SERIAL PRIMARY KEY,
  model_id     INTEGER     NULL REFERENCES ai_forecast_models(id) ON DELETE SET NULL,
  scenario_id  INTEGER     NULL REFERENCES ai_forecast_scenarios(id) ON DELETE CASCADE,
  metric       VARCHAR(20) NOT NULL DEFAULT 'revenue', -- revenue | demand | capacity
  horizon      INTEGER     NOT NULL DEFAULT 30,
  data         JSONB       NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_forecasts_metric ON ai_forecasts (metric, generated_at DESC);

-- Дефолтна модель
INSERT INTO ai_forecast_models (code, name, type, params, is_active)
VALUES ('decomposition_v1', 'Декомпозиція (тренд+сезонність+свята)', 'decomposition',
        '{"window_days":120,"weekly_seasonality":true,"holiday_boost":true}', TRUE)
ON CONFLICT (code) DO NOTHING;
