-- 066: AI-09 AI Call Analysis — анализ телефонных разговоров.
-- Прагматично: вход = текстовый транскрипт (менеджер вставляет текст разговора) ИЛИ audio_url
-- (best-effort транскрипция через Gemini, если доступно). NLP-анализ, оценка по скрипту, коучинг, аналитика.
-- Адаптировано под реальную схему: integer operator/client/branch, BIGSERIAL id, RLS по tenant_id.
BEGIN;

-- 066.1 Записи звонков (метаданные)
CREATE TABLE IF NOT EXISTS ai_call_recordings (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  call_id         TEXT,                      -- ID звонка из телефонии (если есть)
  branch_id       INTEGER,
  operator_id     INTEGER,                   -- администратор (masters/employees)
  operator_name   TEXT,                      -- денормализовано (если нет FK)
  client_id       INTEGER,
  client_phone    TEXT,
  direction       TEXT NOT NULL DEFAULT 'inbound', -- inbound | outbound
  audio_url       TEXT,
  audio_duration_s INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | transcribing | analyzing | completed | error
  error_message   TEXT,
  processing_time_ms INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_callrec_branch ON ai_call_recordings (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_callrec_operator ON ai_call_recordings (operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_callrec_status ON ai_call_recordings (status);

-- 066.2 Транскрипты
CREATE TABLE IF NOT EXISTS ai_call_transcripts (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  recording_id BIGINT NOT NULL REFERENCES ai_call_recordings(id) ON DELETE CASCADE,
  language     TEXT NOT NULL DEFAULT 'uk',
  transcript   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{speaker,text,start_s,end_s}]
  full_text    TEXT NOT NULL,
  word_count   INTEGER,
  stt_model    TEXT,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', full_text)) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_calltr_rec ON ai_call_transcripts (recording_id);
CREATE INDEX IF NOT EXISTS ix_calltr_tsv ON ai_call_transcripts USING gin(tsv);

-- 066.3 NLP-анализ
CREATE TABLE IF NOT EXISTS ai_call_analysis (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  transcript_id   BIGINT NOT NULL REFERENCES ai_call_transcripts(id) ON DELETE CASCADE,
  recording_id    BIGINT NOT NULL REFERENCES ai_call_recordings(id) ON DELETE CASCADE,
  topic           TEXT,        -- booking | inquiry | complaint | cancel | reschedule | follow_up | other
  intent          TEXT,
  sentiment       TEXT,        -- positive | neutral | negative
  sentiment_score NUMERIC(3,2),
  outcome         TEXT,        -- booked | not_booked | will_callback | complaint_resolved | escalated | info_provided
  entities        JSONB NOT NULL DEFAULT '{}'::jsonb,
  objections      TEXT[] NOT NULL DEFAULT '{}',
  keywords        TEXT[] NOT NULL DEFAULT '{}',
  summary         TEXT,
  is_escalation   BOOLEAN NOT NULL DEFAULT FALSE,
  crm_suggestion  JSONB,
  appointment_id  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_callan_topic ON ai_call_analysis (topic, outcome);
CREATE INDEX IF NOT EXISTS ix_callan_rec ON ai_call_analysis (recording_id);

-- 066.4 Скрипты разговора (эталоны)
CREATE TABLE IF NOT EXISTS ai_call_scripts (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id   INTEGER,
  name        TEXT NOT NULL,
  scenario    TEXT NOT NULL DEFAULT 'inbound_booking', -- inbound_booking | outbound_reminder | complaint | upsell
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{order,name,description,example,weight}]
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_callscript_branch ON ai_call_scripts (branch_id, scenario, is_active);

-- 066.5 Оценка соответствия скрипту + скоринг
CREATE TABLE IF NOT EXISTS ai_script_compliance (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  analysis_id        BIGINT NOT NULL REFERENCES ai_call_analysis(id) ON DELETE CASCADE,
  script_id          BIGINT REFERENCES ai_call_scripts(id) ON DELETE SET NULL,
  operator_id        INTEGER,
  checklist          JSONB NOT NULL DEFAULT '{}'::jsonb,
  compliance_percent NUMERIC(5,2),
  politeness_score   NUMERIC(3,1),
  empathy_score      NUMERIC(3,1),
  efficiency_score   NUMERIC(3,1),
  upsell_score       NUMERIC(3,1) DEFAULT 0,
  overall_score      NUMERIC(3,1),
  weak_points        TEXT[] NOT NULL DEFAULT '{}',
  ai_notes           TEXT,
  coaching_tips      TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_compl_operator ON ai_script_compliance (operator_id, overall_score, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_compl_analysis ON ai_script_compliance (analysis_id);

-- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_call_recordings','ai_call_transcripts','ai_call_analysis','ai_call_scripts','ai_script_compliance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_call_recordings, ai_call_transcripts, ai_call_analysis, ai_call_scripts, ai_script_compliance TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE ai_call_recordings_id_seq, ai_call_transcripts_id_seq, ai_call_analysis_id_seq, ai_call_scripts_id_seq, ai_script_compliance_id_seq TO app_tenant;

COMMIT;
