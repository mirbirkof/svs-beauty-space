-- 077: MGT-09 Surveys — опитування клієнтів/співробітників із фокусом на NPS/CSAT/CES.
-- На відміну від універсального Forms (MGT-08) — заточено під метрики задоволеності й тренди.
-- Прагматика під один салон: BIGSERIAL id, tenant_id UUID + RLS (як 067/075), integer client/master/service.
-- Публічне заповнення через per-response token. Награда/нотифікації — через існуючі шини (event-bus).
BEGIN;

-- 077.1 Опитування
CREATE TABLE IF NOT EXISTS surveys (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  type               TEXT NOT NULL DEFAULT 'custom',   -- nps|csat|ces|post_visit|employee|custom
  status             TEXT NOT NULL DEFAULT 'draft',    -- draft|active|paused|closed|archived
  is_anonymous       BOOLEAN NOT NULL DEFAULT FALSE,
  language           TEXT NOT NULL DEFAULT 'uk',
  branding           JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_type       TEXT,                             -- post_visit|periodic|manual|NULL
  trigger_config     JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"delay_hours":2,"period_months":3,"min_visits":3}
  cooldown_days      INTEGER NOT NULL DEFAULT 14,
  max_responses      INTEGER,
  response_count     INTEGER NOT NULL DEFAULT 0,
  target_segment_id  INTEGER,
  ab_test_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  thank_you_message  TEXT NOT NULL DEFAULT 'Дякуємо за ваш відгук!',
  escalation_config  JSONB NOT NULL DEFAULT '{"nps_threshold":6,"csat_threshold":2,"notify_roles":["manager"]}'::jsonb,
  is_deleted         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by         INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_surveys_tenant_status ON surveys (tenant_id, status) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS ix_surveys_type ON surveys (tenant_id, type);

-- 077.2 Питання опитування
CREATE TABLE IF NOT EXISTS survey_questions (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  survey_id      BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  question_type  TEXT NOT NULL,   -- nps_scale|csat_scale|ces_scale|star_rating|single_choice|multi_choice|free_text|yes_no
  text           TEXT NOT NULL,
  text_variant_b TEXT,            -- для A/B тесту
  help_text      TEXT,
  is_required    BOOLEAN NOT NULL DEFAULT TRUE,
  options        JSONB,           -- для choice: [{"value":"quality","label":"Якість роботи"}]
  skip_logic     JSONB,           -- {"if_answer_lt":7,"then_show_question_id":123}
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_squestions_survey ON survey_questions (survey_id, sort_order);

-- 077.3 Відповіді (заповнення)
CREATE TABLE IF NOT EXISTS survey_responses (
  id                     BIGSERIAL PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  survey_id              BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  token                  TEXT NOT NULL,             -- унікальний токен для публічного заповнення
  client_id              INTEGER,                   -- NULL для анонімних/співробітників
  employee_respondent_id INTEGER,                   -- для опитувань співробітників
  appointment_id         INTEGER,                   -- контекст візиту
  master_id              INTEGER,                   -- майстер, що обслужив
  service_id             INTEGER,
  channel                TEXT,                      -- telegram|sms|email|web
  ab_variant             TEXT,                      -- A|B
  status                 TEXT NOT NULL DEFAULT 'started', -- started|completed|partial|expired
  nps_score              INTEGER,                   -- 0-10
  csat_score             INTEGER,                   -- 1-5
  ces_score              INTEGER,                   -- 1-7
  is_escalated           BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_status      TEXT,                      -- new|contacted|resolved|unresolved
  escalation_handled_by  INTEGER,
  escalation_handled_at  TIMESTAMPTZ,
  escalation_note        TEXT,
  completed_at           TIMESTAMPTZ,
  ip_address             TEXT,
  user_agent             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, token)
);
CREATE INDEX IF NOT EXISTS ix_sresp_survey ON survey_responses (survey_id, status);
CREATE INDEX IF NOT EXISTS ix_sresp_master ON survey_responses (tenant_id, master_id);
CREATE INDEX IF NOT EXISTS ix_sresp_escalation ON survey_responses (tenant_id, is_escalated, escalation_status) WHERE is_escalated = TRUE;
CREATE INDEX IF NOT EXISTS ix_sresp_completed ON survey_responses (tenant_id, completed_at DESC);

-- 077.4 Окремі відповіді на питання
CREATE TABLE IF NOT EXISTS survey_answers (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  response_id    BIGINT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id    BIGINT NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  answer_numeric INTEGER,
  answer_text    TEXT,
  answer_choice  JSONB,
  answer_boolean BOOLEAN,
  ab_variant     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_sanswers_response ON survey_answers (response_id);
CREATE INDEX IF NOT EXISTS ix_sanswers_question ON survey_answers (question_id);

-- RLS на всіх нових таблицях
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['surveys','survey_questions','survey_responses','survey_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON surveys, survey_questions, survey_responses, survey_answers TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE surveys_id_seq, survey_questions_id_seq, survey_responses_id_seq, survey_answers_id_seq TO app_tenant;

COMMIT;
