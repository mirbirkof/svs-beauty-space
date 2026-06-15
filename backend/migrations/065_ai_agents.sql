-- 065: AI-06 AI Agents — платформа автономных агентов с tool-calling, памятью, guardrails, аудитом.
-- Агенты используют как инструменты уже построенные модули (KB, услуги, клиенты, аналитика).
-- Каталог инструментов (ai_agent_tools) — общий справочник без RLS (наполняется из кода при старте).
-- Остальные таблицы изолированы по тенанту (RLS). ID: BIGSERIAL, branch/client/user — integer.
BEGIN;

-- 065.1 Каталог инструментов (общий, read-shared; запись — owner/код)
CREATE TABLE IF NOT EXISTS ai_agent_tools (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  category         TEXT NOT NULL,            -- booking | communication | crm | analytics | knowledge | finance | tasks
  description      TEXT NOT NULL,
  parameters_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_permission TEXT,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
  is_destructive   BOOLEAN NOT NULL DEFAULT FALSE,
  is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_agtools_cat ON ai_agent_tools (category, is_enabled);

-- 065.2 Агенты
CREATE TABLE IF NOT EXISTS ai_agents (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id       INTEGER,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'custom', -- receptionist | marketer | analyst | hr | finance | custom
  description     TEXT,
  system_prompt   TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT 'auto',
  temperature     NUMERIC(2,1) NOT NULL DEFAULT 0.3,
  max_tokens      INTEGER NOT NULL DEFAULT 1500,
  max_tool_calls  INTEGER NOT NULL DEFAULT 12,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  tool_names      TEXT[] NOT NULL DEFAULT '{}',
  guardrails      JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule        JSONB,
  event_triggers  TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | active | paused | archived
  version         INTEGER NOT NULL DEFAULT 1,
  is_template     BOOLEAN NOT NULL DEFAULT FALSE,
  total_runs      INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_agents_status ON ai_agents (status, role);

-- 065.3 Сессии исполнения
CREATE TABLE IF NOT EXISTS ai_agent_sessions (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  agent_id         BIGINT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  branch_id        INTEGER,
  triggered_by     TEXT NOT NULL DEFAULT 'user', -- user | event | schedule | agent
  trigger_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id          INTEGER,
  client_id        INTEGER,
  status           TEXT NOT NULL DEFAULT 'running', -- running | completed | failed | timeout | escalated
  messages         JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls_count INTEGER NOT NULL DEFAULT 0,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(8,6) NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  error_message    TEXT,
  final_response   TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_agsess_agent ON ai_agent_sessions (agent_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_agsess_client ON ai_agent_sessions (client_id, started_at DESC);

-- 065.4 Действия (аудит каждого шага)
CREATE TABLE IF NOT EXISTS ai_agent_actions (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  session_id    BIGINT NOT NULL REFERENCES ai_agent_sessions(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL DEFAULT 0,
  action_type   TEXT NOT NULL,             -- tool_call | reasoning | confirmation_request | escalation
  tool_name     TEXT,
  input         JSONB,
  output        JSONB,
  reasoning     TEXT,
  confidence    NUMERIC(3,2),
  status        TEXT NOT NULL DEFAULT 'executed', -- pending | executed | confirmed | rejected | failed
  duration_ms   INTEGER,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_agact_session ON ai_agent_actions (session_id, step_index);

-- 065.5 Память агента
CREATE TABLE IF NOT EXISTS ai_agent_memory (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  agent_id          BIGINT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL DEFAULT 'agent', -- client | agent | global
  scope_id          TEXT,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_session_id BIGINT,
  relevance_score   NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  last_accessed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agmem ON ai_agent_memory (tenant_id, agent_id, scope, COALESCE(scope_id,''), key);

-- RLS на тенант-скоуп таблицах (каталог tools — без RLS, общий справочник)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_agents','ai_agent_sessions','ai_agent_actions','ai_agent_memory'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_tools, ai_agents, ai_agent_sessions, ai_agent_actions, ai_agent_memory TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE ai_agent_tools_id_seq, ai_agents_id_seq, ai_agent_sessions_id_seq, ai_agent_actions_id_seq, ai_agent_memory_id_seq TO app_tenant;

COMMIT;
