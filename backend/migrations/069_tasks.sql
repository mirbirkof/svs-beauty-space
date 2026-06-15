-- 069: MGT-01 Tasks — задачі/доручення для команди салону.
-- Прагматично під один салон: теги→TEXT[], чек-лист→JSONB, вкладення через існуючий files.js,
-- спостерігачі спрощені. Без важких task_tag_links/task_watchers таблиць.
BEGIN;

CREATE TABLE IF NOT EXISTS tasks (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  title             TEXT NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium',   -- critical|high|medium|low
  status            TEXT NOT NULL DEFAULT 'todo',      -- backlog|todo|in_progress|review|done|cancelled
  assignee_id       INTEGER,
  assignee_name     TEXT,
  creator_id        INTEGER,
  creator_name      TEXT,
  due_date          DATE,
  estimated_minutes INTEGER,
  actual_minutes    INTEGER,
  client_id         INTEGER,
  appointment_id    INTEGER,
  service_id        INTEGER,
  tags              TEXT[] NOT NULL DEFAULT '{}',
  checklist         JSONB  NOT NULL DEFAULT '[]',      -- [{text,done}]
  recurrence        TEXT,                              -- daily|weekly|monthly|null
  recurrence_next   DATE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_tasks_status   ON tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks (tenant_id, assignee_id);
CREATE INDEX IF NOT EXISTS ix_tasks_due      ON tasks (tenant_id, due_date);

CREATE TABLE IF NOT EXISTS task_comments (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id     INTEGER,
  author_name   TEXT,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_task_comments_task ON task_comments (tenant_id, task_id);

CREATE TABLE IF NOT EXISTS task_templates (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  priority      TEXT NOT NULL DEFAULT 'medium',
  checklist     JSONB NOT NULL DEFAULT '[]',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','task_comments','task_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tasks, task_comments, task_templates TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE tasks_id_seq, task_comments_id_seq, task_templates_id_seq TO app_tenant;

COMMIT;
