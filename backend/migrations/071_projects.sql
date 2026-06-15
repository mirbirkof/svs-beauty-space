-- 071: MGT-02 Projects — проекти/ініціативи салону (ремонт, навчання, ребрендинг).
-- Ієрархія: проект → фаза → веха (milestone) → задача (MGT-01). Прагматично під один салон:
-- без branch_id (один філіал), UUID→BIGSERIAL/INTEGER як у решті схеми, Gantt рахується на льоту.
BEGIN;

CREATE TABLE IF NOT EXISTS project_templates (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  project_type  TEXT NOT NULL DEFAULT 'other',
  description   TEXT,
  -- структура: {phases:[{name,offset_days,duration_days,milestones:[{title,offset_days}],tasks:[{title,priority}]}], budget_planned}
  structure     JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id    BIGINT,
  title          TEXT NOT NULL,
  description    TEXT,
  project_type   TEXT NOT NULL DEFAULT 'other',  -- renovation|new_branch|training|marketing|crm_implementation|certification|other
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft|planning|active|on_hold|completed|cancelled
  priority       TEXT NOT NULL DEFAULT 'medium', -- high|medium|low
  owner_id       INTEGER,
  owner_name     TEXT,
  planned_start  DATE,
  planned_end    DATE,
  actual_start   DATE,
  actual_end     DATE,
  budget_planned NUMERIC(12,2) NOT NULL DEFAULT 0,
  budget_actual  NUMERIC(12,2) NOT NULL DEFAULT 0,
  progress       INTEGER NOT NULL DEFAULT 0,      -- 0-100
  progress_mode  TEXT NOT NULL DEFAULT 'auto',    -- auto|manual
  tags           TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_projects_status ON projects (tenant_id, status);

CREATE TABLE IF NOT EXISTS project_phases (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  planned_start DATE,
  planned_end   DATE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|active|done
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_project_phases_proj ON project_phases (tenant_id, project_id);

CREATE TABLE IF NOT EXISTS project_milestones (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id      BIGINT REFERENCES project_phases(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  due_date      DATE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|achieved|missed
  achieved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_project_ms_proj ON project_milestones (tenant_id, project_id);

-- Привʼязка задач MGT-01 до проекту/фази
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase_id   BIGINT;
CREATE INDEX IF NOT EXISTS ix_tasks_project ON tasks (tenant_id, project_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','project_phases','project_milestones','project_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON projects, project_phases, project_milestones, project_templates TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE projects_id_seq, project_phases_id_seq, project_milestones_id_seq, project_templates_id_seq TO app_tenant;

COMMIT;
