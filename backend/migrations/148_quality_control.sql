-- 148: AI-10 Quality Control — AI-скоринг якості, алерти, правила, NLP-аналіз відгуків.
--      + доповнення MGT-05: mystery_shopper_attachments (вкладення до звітів тайного покупця).
-- Нові таблиці: ai_quality_scores, ai_quality_rules, ai_quality_alerts, ai_service_analysis,
--               mystery_shopper_attachments.
-- Ідемпотентно: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS.
-- RLS + GRANT як у 079/105. BIGSERIAL id, tenant_id UUID NOT NULL DEFAULT current_tenant_id().
BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 148.1  AI Quality Scores — щоденні snapshot балу якості
--         по майстрах, адміністраторах, філіалах, послугах
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_quality_scores (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id         INTEGER,                           -- може бути NULL (загальний по салону)
  entity_type       TEXT NOT NULL,                     -- 'master'|'admin'|'branch'|'service'
  entity_id         TEXT NOT NULL,                     -- employee_id, branch_id, service_id (TEXT для гнучкості)
  score_date        DATE NOT NULL,                     -- дата snapshot
  overall_score     NUMERIC(5,2) NOT NULL DEFAULT 0,  -- 0.00–100.00
  components        JSONB NOT NULL DEFAULT '{}',
  -- master:  {avg_rating, repeat_rate, review_sentiment, complaint_rate, on_time, upsell, photo_score}
  -- branch:  {avg_master_score, nps, csat, wait_time_avg, no_show_rate}
  -- admin:   {call_score, chat_score, conversion_rate, first_contact_resolution}
  trend             TEXT NOT NULL DEFAULT 'stable',   -- 'improving'|'stable'|'declining'|'critical_decline'
  trend_delta       NUMERIC(5,2),                     -- зміна score vs попередній period
  benchmark_own     NUMERIC(5,2),                     -- середній score за 90 днів
  benchmark_network NUMERIC(5,2),                     -- середній по мережі (якщо є)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_qs_entity_date
  ON ai_quality_scores (tenant_id, entity_type, entity_id, score_date);
CREATE INDEX IF NOT EXISTS ix_ai_qs_entity
  ON ai_quality_scores (tenant_id, entity_type, entity_id, score_date DESC);
CREATE INDEX IF NOT EXISTS ix_ai_qs_branch_date
  ON ai_quality_scores (tenant_id, branch_id, score_date DESC);
CREATE INDEX IF NOT EXISTS ix_ai_qs_trend
  ON ai_quality_scores (tenant_id, trend, score_date DESC)
  WHERE trend IN ('declining','critical_decline');

-- ─────────────────────────────────────────────────────────────────
-- 148.2  AI Quality Rules — правила алертів (настроювані менеджером)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_quality_rules (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id         INTEGER,                           -- NULL = глобальне правило
  name              TEXT NOT NULL,                     -- 'NPS нижче 7.0'
  rule_type         TEXT NOT NULL DEFAULT 'threshold', -- 'threshold'|'trend'|'anomaly'|'score_drop'|'review_negative'
  metric            TEXT NOT NULL,                     -- 'nps'|'csat'|'quality_score'|'wait_time'|...
  entity_type       TEXT,                              -- 'master'|'admin'|'branch'|NULL=всі
  condition_json    JSONB NOT NULL DEFAULT '{}',
  -- threshold: {operator: '<', value: 7.0}
  -- trend:     {direction: 'down', periods: 3, min_change_pct: 5}
  -- anomaly:   {std_deviations: 2}
  -- score_drop:{drop_pct: 10, period_days: 7}
  severity          TEXT NOT NULL DEFAULT 'warning',  -- 'info'|'warning'|'critical'|'emergency'
  cooldown_hours    INTEGER NOT NULL DEFAULT 24,
  escalation_chain  JSONB DEFAULT '[]',
  -- [{severity:'warning',channels:['push','telegram'],recipients:['manager']}, ...]
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  triggers_count    INTEGER NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  created_by        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ai_qr_branch
  ON ai_quality_rules (tenant_id, branch_id, is_enabled);
CREATE INDEX IF NOT EXISTS ix_ai_qr_metric
  ON ai_quality_rules (tenant_id, metric, rule_type);

-- ─────────────────────────────────────────────────────────────────
-- 148.3  AI Quality Alerts — спрацьовані алерти
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_quality_alerts (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id            INTEGER,
  rule_id              BIGINT REFERENCES ai_quality_rules(id) ON DELETE SET NULL,
  entity_type          TEXT NOT NULL,                  -- 'master'|'admin'|'branch'|'service'|'client'
  entity_id            TEXT NOT NULL,
  severity             TEXT NOT NULL DEFAULT 'warning',-- 'info'|'warning'|'critical'|'emergency'
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  metric_name          TEXT NOT NULL,
  metric_value         NUMERIC(10,2),
  threshold_value      NUMERIC(10,2),
  recommended_actions  JSONB DEFAULT '[]',             -- ['позвонити клієнту', 'перевірити майстра']
  status               TEXT NOT NULL DEFAULT 'active', -- 'active'|'acknowledged'|'resolved'|'false_positive'|'auto_resolved'
  acknowledged_by      INTEGER,
  acknowledged_at      TIMESTAMPTZ,
  action_plan          TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ai_qa_branch_status
  ON ai_quality_alerts (tenant_id, branch_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_qa_entity
  ON ai_quality_alerts (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_qa_active_severity
  ON ai_quality_alerts (tenant_id, severity, status, created_at DESC)
  WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────
-- 148.4  AI Service Analysis — NLP-аналіз відгуків / повідомлень
--         (Review Analysis 10.01)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_service_analysis (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id        INTEGER,
  source_type      TEXT NOT NULL DEFAULT 'internal_form',
  -- 'google_review'|'instagram_comment'|'internal_form'|'telegram'|'chat'|'nps_survey'
  source_id        TEXT,                               -- external ID відгуку
  source_url       TEXT,                               -- URL оригіналу
  client_id        INTEGER,                            -- NULL якщо не визначено
  raw_text         TEXT NOT NULL,
  language         TEXT NOT NULL DEFAULT 'uk',
  sentiment        TEXT NOT NULL DEFAULT 'neutral',    -- 'positive'|'neutral'|'negative'
  sentiment_score  NUMERIC(3,2) NOT NULL DEFAULT 0,   -- -1.00..+1.00
  aspects          JSONB NOT NULL DEFAULT '[]',
  -- [{aspect:'master',sentiment:'positive',text:'Анна — чудовий колорист!'}]
  entities         JSONB NOT NULL DEFAULT '{}',
  -- {master_names:['Анна'],services:['фарбування'],branch:'Оболонь'}
  emotions         JSONB DEFAULT '[]',                 -- ['gratitude','satisfaction']
  urgency          TEXT NOT NULL DEFAULT 'normal',     -- 'normal'|'high'|'critical'
  is_actionable    BOOLEAN NOT NULL DEFAULT FALSE,
  suggested_response TEXT,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ai_sa_branch_source
  ON ai_service_analysis (tenant_id, branch_id, source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_sa_sentiment
  ON ai_service_analysis (tenant_id, sentiment, urgency, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_sa_actionable
  ON ai_service_analysis (tenant_id, is_actionable, created_at DESC)
  WHERE is_actionable = TRUE;
CREATE INDEX IF NOT EXISTS ix_ai_sa_client
  ON ai_service_analysis (tenant_id, client_id)
  WHERE client_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 148.5  Mystery Shopper Attachments — вкладення до звітів
--         (MGT-05: 05.04 підтримка фото/аудіо/відео)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mystery_shopper_attachments (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  report_id   BIGINT NOT NULL REFERENCES mystery_shopper_reports(id) ON DELETE CASCADE,
  file_url    TEXT NOT NULL,
  file_name   TEXT,
  file_size   INTEGER,
  mime_type   TEXT,
  media_type  TEXT NOT NULL DEFAULT 'photo',           -- 'photo'|'audio'|'video'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_msa_report
  ON mystery_shopper_attachments (tenant_id, report_id);

-- ─────────────────────────────────────────────────────────────────
-- RLS для всіх нових таблиць
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_quality_scores',
    'ai_quality_rules',
    'ai_quality_alerts',
    'ai_service_analysis',
    'mystery_shopper_attachments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = COALESCE(
          NULLIF(current_setting(''app.tenant_id'', true), '')::uuid,
          tenant_id
        ))
        WITH CHECK (tenant_id = COALESCE(
          NULLIF(current_setting(''app.tenant_id'', true), '')::uuid,
          tenant_id
        ))
    $p$, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- GRANT-и
-- ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ai_quality_scores,
     ai_quality_rules,
     ai_quality_alerts,
     ai_service_analysis,
     mystery_shopper_attachments
  TO app_tenant;

GRANT USAGE, SELECT
  ON SEQUENCE ai_quality_scores_id_seq,
             ai_quality_rules_id_seq,
             ai_quality_alerts_id_seq,
             ai_service_analysis_id_seq,
             mystery_shopper_attachments_id_seq
  TO app_tenant;

COMMIT;
