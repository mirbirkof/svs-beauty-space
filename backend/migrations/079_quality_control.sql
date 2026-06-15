-- 079: MGT-05 Quality Control — стандарти якості, чек-листи, перевірки (аудити),
-- невідповідності+CAPA, таємний покупець, розклад перевірок. KPI якості по майстрах.
-- Прагматика під один салон: BIGSERIAL id, tenant_id UUID + RLS (як 075/077), integer
-- branch/inspector/master/service (без жорстких FK — як incidents.js). Невідповідність
-- може породити задачу MGT-01 (linked_task_id) / інцидент MGT-04 (linked_incident_id).
BEGIN;

-- 079.1 Стандарти якості
CREATE TABLE IF NOT EXISTS qc_standards (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id     INTEGER,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'service',  -- hygiene|procedure|service|facility|appearance|safety
  applicable_services JSONB,
  photo_correct_url   TEXT,
  photo_incorrect_url TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft|active|archived
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcstd_tenant ON qc_standards (tenant_id, category, status);

-- 079.2 Чек-листи
CREATE TABLE IF NOT EXISTS qc_checklists (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id      INTEGER,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  checklist_type TEXT NOT NULL DEFAULT 'general', -- daily|procedure|general|mystery_shopper
  applicable_role TEXT,                           -- master|administrator|cleaner|NULL
  applicable_service_id INTEGER,
  total_weight   INTEGER NOT NULL DEFAULT 0,
  pass_threshold INTEGER NOT NULL DEFAULT 80,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qccl_tenant ON qc_checklists (tenant_id, checklist_type, active);

-- 079.3 Пункти чек-листа
CREATE TABLE IF NOT EXISTS qc_checklist_items (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  checklist_id    BIGINT NOT NULL REFERENCES qc_checklists(id) ON DELETE CASCADE,
  standard_id     BIGINT REFERENCES qc_standards(id) ON DELETE SET NULL,
  text            TEXT NOT NULL,
  category        TEXT,
  weight          INTEGER NOT NULL DEFAULT 1,
  requires_photo  BOOLEAN NOT NULL DEFAULT FALSE,
  evaluation_type TEXT NOT NULL DEFAULT 'pass_fail', -- pass_fail|score_5|score_10
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcli_checklist ON qc_checklist_items (checklist_id, sort_order);

-- 079.4 Перевірки (аудити)
CREATE TABLE IF NOT EXISTS qc_checks (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id             INTEGER,
  checklist_id          BIGINT NOT NULL REFERENCES qc_checklists(id),
  check_type            TEXT NOT NULL DEFAULT 'planned', -- planned|unplanned
  inspector_id          INTEGER,
  inspector_name        TEXT,
  inspected_employee_id INTEGER,
  inspected_zone        TEXT,
  scheduled_date        DATE,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|completed|reviewed
  total_score           NUMERIC(5,2),
  result                TEXT,                              -- excellent|good|satisfactory|unsatisfactory
  inspector_notes       TEXT,
  signature_url         TEXT,
  reviewed_by           INTEGER,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcchk_tenant ON qc_checks (tenant_id, status, scheduled_date DESC);
CREATE INDEX IF NOT EXISTS ix_qcchk_emp ON qc_checks (tenant_id, inspected_employee_id);

-- 079.5 Результати по пунктах
CREATE TABLE IF NOT EXISTS qc_check_results (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  check_id    BIGINT NOT NULL REFERENCES qc_checks(id) ON DELETE CASCADE,
  item_id     BIGINT NOT NULL REFERENCES qc_checklist_items(id) ON DELETE CASCADE,
  evaluation  TEXT NOT NULL,             -- pass|fail|na|1..10
  score       NUMERIC(5,2),
  comment     TEXT,
  photo_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcres_check ON qc_check_results (check_id);

-- 079.6 Тайний покупець
CREATE TABLE IF NOT EXISTS mystery_shopper_reports (
  id                      BIGSERIAL PRIMARY KEY,
  tenant_id               UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id               INTEGER,
  shopper_name            TEXT NOT NULL,
  shopper_contact         TEXT,
  visit_date              DATE NOT NULL,
  service_id              INTEGER,
  employee_id             INTEGER,
  scenario                TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|reviewed|action_taken
  overall_score           NUMERIC(5,2),
  first_impression_score  INTEGER,
  greeting_score          INTEGER,
  consultation_score      INTEGER,
  procedure_score         INTEGER,
  checkout_score          INTEGER,
  farewell_score          INTEGER,
  cleanliness_score       INTEGER,
  overall_impression_score INTEGER,
  first_impression_comment TEXT,
  greeting_comment        TEXT,
  consultation_comment    TEXT,
  procedure_comment       TEXT,
  checkout_comment        TEXT,
  farewell_comment        TEXT,
  cleanliness_comment     TEXT,
  overall_impression_comment TEXT,
  recommendations         TEXT,
  reviewed_by             INTEGER,
  reviewed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_msr_tenant ON mystery_shopper_reports (tenant_id, visit_date DESC, status);

-- 079.7 Невідповідності + CAPA
CREATE TABLE IF NOT EXISTS qc_non_conformities (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id          INTEGER,
  check_id           BIGINT REFERENCES qc_checks(id) ON DELETE SET NULL,
  mystery_report_id  BIGINT REFERENCES mystery_shopper_reports(id) ON DELETE SET NULL,
  check_result_id    BIGINT REFERENCES qc_check_results(id) ON DELETE SET NULL,
  employee_id        INTEGER,
  severity           TEXT NOT NULL DEFAULT 'minor', -- minor|major|critical
  description        TEXT NOT NULL,
  corrective_action  TEXT,
  preventive_action  TEXT,
  assignee_id        INTEGER,
  due_date           DATE,
  status             TEXT NOT NULL DEFAULT 'open',  -- open|in_progress|corrected|verified|closed
  linked_task_id     BIGINT,
  linked_incident_id BIGINT,
  verified_by        INTEGER,
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcnc_tenant ON qc_non_conformities (tenant_id, status, severity);
CREATE INDEX IF NOT EXISTS ix_qcnc_emp ON qc_non_conformities (tenant_id, employee_id);

-- 079.8 Розклад перевірок
CREATE TABLE IF NOT EXISTS qc_check_schedule (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id        INTEGER,
  checklist_id     BIGINT NOT NULL REFERENCES qc_checklists(id) ON DELETE CASCADE,
  inspector_id     INTEGER,
  frequency        TEXT NOT NULL DEFAULT 'weekly', -- daily|weekly|monthly
  day_of_week      INTEGER,
  day_of_month     INTEGER,
  time_of_day      TIME,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_generated_at TIMESTAMPTZ,
  next_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qcsched_active ON qc_check_schedule (tenant_id, active, next_run_at);

-- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['qc_standards','qc_checklists','qc_checklist_items','qc_checks','qc_check_results','mystery_shopper_reports','qc_non_conformities','qc_check_schedule'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON qc_standards, qc_checklists, qc_checklist_items, qc_checks, qc_check_results, mystery_shopper_reports, qc_non_conformities, qc_check_schedule TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE qc_standards_id_seq, qc_checklists_id_seq, qc_checklist_items_id_seq, qc_checks_id_seq, qc_check_results_id_seq, mystery_shopper_reports_id_seq, qc_non_conformities_id_seq, qc_check_schedule_id_seq TO app_tenant;

COMMIT;
