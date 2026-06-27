-- AI-04 Analytics: предиктивна аналітика, аномалії, авто-інсайти, NLP-запити.
-- Прагматична версія: розрахунок наживо з appointments/cash_operations, персист результатів.

CREATE TABLE IF NOT EXISTS ai_predictions (
  id          SERIAL PRIMARY KEY,
  kind        VARCHAR(30) NOT NULL,             -- churn | demand | revenue | ltv
  subject_type VARCHAR(20) NULL,                -- client | service | master | salon
  subject_id  INTEGER     NULL,
  value       NUMERIC     NULL,                 -- прогнозне значення / ризик 0..1
  horizon_days INTEGER    NULL,
  details     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_pred_kind ON ai_predictions (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_anomalies (
  id          SERIAL PRIMARY KEY,
  metric      VARCHAR(30) NOT NULL,             -- revenue | appointments | avg_check | noshow
  anomaly_date DATE       NOT NULL,
  observed    NUMERIC     NULL,
  expected    NUMERIC     NULL,
  z_score     NUMERIC     NULL,
  direction   VARCHAR(8)  NULL,                 -- spike | drop
  severity    VARCHAR(10) NOT NULL DEFAULT 'medium', -- low | medium | high
  status      VARCHAR(12) NOT NULL DEFAULT 'open',   -- open | acknowledged | resolved | ignored
  note        TEXT        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (metric, anomaly_date)
);
CREATE INDEX IF NOT EXISTS idx_ai_anom_status ON ai_anomalies (status, anomaly_date DESC);

CREATE TABLE IF NOT EXISTS ai_insights (
  id          SERIAL PRIMARY KEY,
  category    VARCHAR(30) NOT NULL,             -- revenue | retention | capacity | pricing | marketing
  severity    VARCHAR(10) NOT NULL DEFAULT 'info', -- info | warning | opportunity
  title       VARCHAR(200) NOT NULL,
  body        TEXT        NULL,
  metric_value NUMERIC    NULL,
  action      VARCHAR(200) NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'new',   -- new | applied | dismissed
  fingerprint VARCHAR(80) NULL UNIQUE,          -- дедуп однакових інсайтів
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at  TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_insights_status ON ai_insights (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_nl_queries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NULL,
  question    TEXT        NOT NULL,
  intent      VARCHAR(40) NULL,                 -- розпізнаний намір
  answer      JSONB       NULL,
  success     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_nlq_user ON ai_nl_queries (user_id, created_at DESC);
