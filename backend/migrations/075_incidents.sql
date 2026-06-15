-- 075: MGT-04 Incident Management — реєстрація/обробка нештатних ситуацій (скарги, поломки, конфлікти).
-- Тікет-система: open→investigating→pending_action→resolved→closed/reopened. SLA за пріоритетом,
-- root cause analysis + корективні/превентивні дії. Прагматика під один салон: BIGSERIAL, без branch_id,
-- вкладення через files.js. Звʼязок з клієнтом/майстром/візитом + може породити задачу MGT-01.
BEGIN;

CREATE TABLE IF NOT EXISTS incident_categories (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  incident_number       TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  incident_type         TEXT NOT NULL DEFAULT 'other',  -- complaint|equipment|conflict|safety|sanitary|it|theft|other
  category_id           BIGINT REFERENCES incident_categories(id) ON DELETE SET NULL,
  priority              TEXT NOT NULL DEFAULT 'medium',  -- critical|high|medium|low
  status                TEXT NOT NULL DEFAULT 'open',    -- open|investigating|pending_action|resolved|closed|reopened
  source                TEXT NOT NULL DEFAULT 'manual',  -- manual|review|callback|auto
  source_ref_id         INTEGER,
  assignee_id           INTEGER,
  assignee_name         TEXT,
  reporter_id           INTEGER,
  reporter_name         TEXT,
  client_id             INTEGER,
  related_employee_id   INTEGER,
  appointment_id        INTEGER,
  service_id            INTEGER,
  sla_first_response_at TIMESTAMPTZ,
  sla_resolution_at     TIMESTAMPTZ,
  first_responded_at    TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  root_cause_category   TEXT,   -- human_error|process_gap|equipment_failure|supplier_issue|communication|training|other
  root_cause_description TEXT,
  corrective_action     TEXT,
  preventive_action     TEXT,
  compensation          TEXT,
  client_satisfaction   TEXT,   -- satisfied|partial|unsatisfied
  escalation_level      INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_incidents_number ON incidents (tenant_id, incident_number);
CREATE INDEX IF NOT EXISTS ix_incidents_status ON incidents (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_incidents_sla    ON incidents (tenant_id, sla_resolution_at);
CREATE INDEX IF NOT EXISTS ix_incidents_client ON incidents (tenant_id, client_id);

CREATE TABLE IF NOT EXISTS incident_comments (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  incident_id  BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author_id    INTEGER,
  author_name  TEXT,
  body         TEXT NOT NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_incident_comments_inc ON incident_comments (tenant_id, incident_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['incidents','incident_categories','incident_comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON incidents, incident_categories, incident_comments TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE incidents_id_seq, incident_categories_id_seq, incident_comments_id_seq TO app_tenant;

COMMIT;
