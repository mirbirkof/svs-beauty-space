-- 174: AI-10 Quality Control v2 — доповнення до 148_quality_control.sql.
-- Базові таблиці (ai_quality_scores, ai_quality_alerts, ai_quality_rules,
-- ai_service_analysis) вже створені в 148. Тут — ЛИШЕ НОВЕ для повного покриття
-- спеки v2 (routes/ai-quality.js, монтаж /api/ai/quality):
--   • ai_quality_score_weights — кастомні ваги Master Score (§10.03 weight
--     customization, RBAC ai.quality.config);
--   • UNIQUE-індекс для upsert ваг по (tenant_id, branch_id) з NULL=салон;
--   • прискорювальні індекси для live-аналітики відгуків (aspects/entities GIN).
-- Ідемпотентно: IF NOT EXISTS. Стиль як 148/161 (tenant_id UUID + RLS + GRANT).
BEGIN;

-- ── 174.1 Кастомні ваги Master Score (настроювані менеджером) ────────────────
CREATE TABLE IF NOT EXISTS ai_quality_score_weights (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id   INTEGER,                       -- NULL = ваги по всьому салону
  weights     JSONB NOT NULL DEFAULT '{}',
  -- {avg_rating:20, repeat_rate:20, review_sentiment:15, complaint_rate:15,
  --  on_time:10, upsell:10, photo_score:10} — сума = 100
  updated_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE по (tenant, branch) з NULL→0 для коректного ON CONFLICT в upsert ваг.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_qsw_tenant_branch
  ON ai_quality_score_weights (tenant_id, COALESCE(branch_id, 0));

-- ── 174.2 Прискорення live-аналітики відгуків (GIN для aspects/entities JSONB) ─
CREATE INDEX IF NOT EXISTS ix_ai_sa_aspects_gin
  ON ai_service_analysis USING GIN (aspects);
CREATE INDEX IF NOT EXISTS ix_ai_sa_entities_gin
  ON ai_service_analysis USING GIN (entities);

-- ── 174.3 RLS для нової таблиці (як 148) ─────────────────────────────────────
ALTER TABLE ai_quality_score_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quality_score_weights FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_quality_score_weights;
CREATE POLICY tenant_isolation ON ai_quality_score_weights
  USING (tenant_id = COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- ── 174.4 GRANT-и (як 148) ───────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ai_quality_score_weights TO app_tenant;
    GRANT USAGE, SELECT ON SEQUENCE ai_quality_score_weights_id_seq TO app_tenant;
  END IF;
END $$;

COMMIT;
