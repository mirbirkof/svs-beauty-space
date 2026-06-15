-- 103: SAL-10 Medical Cards — медична документація клієнтів (алергії, протипоказання, ліки,
-- тести на алергію (patch test), інформовані згоди з підписом, історія формул фарбування, аудит доступу).
-- Критично для безпеки клієнта і юр.захисту салону: warnings-перевірка перед процедурою.
-- Прагматика під один салон: BIGSERIAL, tenant_id+RLS, без branch_id, integer FK на clients/masters/services/appointments.
BEGIN;

CREATE TABLE IF NOT EXISTS medical_cards (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id         INTEGER NOT NULL,
  blood_type        TEXT,
  skin_phototype    INTEGER,            -- 1-6 Фітцпатрик
  skin_type         TEXT,               -- dry|normal|combination|oily|sensitive
  hair_condition    TEXT,               -- normal|dry|oily|damaged|bleached|chemically_treated
  allergies          JSONB NOT NULL DEFAULT '[]',  -- [{allergen,severity,diagnosed_at,notes}]
  contraindications  JSONB NOT NULL DEFAULT '[]',  -- [{condition,active,since,until,notes}]
  chronic_conditions JSONB NOT NULL DEFAULT '[]',  -- [{condition,since,severity,notes}]
  current_medications JSONB NOT NULL DEFAULT '[]', -- [{name,dosage,started_at,until,notes}]
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  cosmetology_anamnesis JSONB,          -- {previous_procedures,skin_grade,glogau_scale,notes}
  treatment_plan        JSONB,          -- {procedures,interval_days,started_at,status}
  home_care_notes   TEXT,
  last_reviewed_at  TIMESTAMPTZ,
  reviewed_by       INTEGER,
  reviewed_by_name  TEXT,
  status            TEXT NOT NULL DEFAULT 'active', -- active|needs_update|archived
  created_by        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_medical_cards_client ON medical_cards (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS ix_medical_cards_status ON medical_cards (tenant_id, status);

CREATE TABLE IF NOT EXISTS allergy_tests (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id       INTEGER NOT NULL,
  medical_card_id BIGINT REFERENCES medical_cards(id) ON DELETE SET NULL,
  employee_id     INTEGER,
  employee_name   TEXT,
  product_name    TEXT NOT NULL,
  product_brand   TEXT,
  product_id      INTEGER,
  application_zone TEXT NOT NULL DEFAULT 'behind_ear', -- behind_ear|inner_elbow|wrist
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exposure_minutes INTEGER NOT NULL DEFAULT 30,
  result_24h      TEXT,   -- negative|mild_reaction|strong_reaction|pending
  result_48h      TEXT,
  final_result    TEXT NOT NULL DEFAULT 'pending', -- negative|mild_reaction|strong_reaction|pending
  photo_before_url TEXT,
  photo_after_url  TEXT,
  notes           TEXT,
  valid_until     DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_allergy_tests_client ON allergy_tests (tenant_id, client_id, valid_until);
CREATE INDEX IF NOT EXISTS ix_allergy_tests_result ON allergy_tests (tenant_id, final_result);

CREATE TABLE IF NOT EXISTS procedure_consents (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id       INTEGER NOT NULL,
  medical_card_id BIGINT REFERENCES medical_cards(id) ON DELETE SET NULL,
  appointment_id  INTEGER,
  service_id      INTEGER,
  template_id     BIGINT,
  consent_type    TEXT NOT NULL DEFAULT 'single', -- single|course|permanent
  procedure_name  TEXT NOT NULL,
  risks_acknowledged BOOLEAN NOT NULL DEFAULT false,
  checklist       JSONB,  -- [{question,answer,critical}]
  signed_by_name  TEXT NOT NULL,
  signature_url   TEXT,
  document_url    TEXT,
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT,
  collected_by    INTEGER,
  collected_by_name TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active|expired|revoked|used
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_consents_client ON procedure_consents (tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS ix_consents_appt   ON procedure_consents (tenant_id, appointment_id);
CREATE INDEX IF NOT EXISTS ix_consents_service ON procedure_consents (tenant_id, service_id);

CREATE TABLE IF NOT EXISTS coloring_formulas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id       INTEGER NOT NULL,
  medical_card_id BIGINT REFERENCES medical_cards(id) ON DELETE SET NULL,
  appointment_id  INTEGER,
  employee_id     INTEGER,
  employee_name   TEXT,
  service_id      INTEGER,
  formula_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  zones           JSONB NOT NULL DEFAULT '[]', -- [{zone,brand,line,shade,oxidant_pct,ratio,amount_g,time_min}]
  pre_treatment   TEXT,
  post_treatment  TEXT,
  total_amount_g  NUMERIC(6,1),
  result_notes    TEXT,
  result_rating   INTEGER,  -- 1-5
  client_rating   INTEGER,  -- 1-5
  next_visit_recommendation TEXT,
  photo_id        INTEGER,
  previous_formula_id BIGINT REFERENCES coloring_formulas(id) ON DELETE SET NULL,
  is_current      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_formulas_client_date ON coloring_formulas (tenant_id, client_id, formula_date DESC);
CREATE INDEX IF NOT EXISTS ix_formulas_current     ON coloring_formulas (tenant_id, client_id, is_current);
CREATE INDEX IF NOT EXISTS ix_formulas_employee    ON coloring_formulas (tenant_id, employee_id);

CREATE TABLE IF NOT EXISTS medical_access_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  medical_card_id BIGINT,
  client_id       INTEGER,
  accessed_by     INTEGER,
  accessed_by_name TEXT,
  action          TEXT NOT NULL DEFAULT 'view', -- view|edit|export|delete
  fields_accessed TEXT[],
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_med_access_card ON medical_access_log (tenant_id, medical_card_id, created_at);
CREATE INDEX IF NOT EXISTS ix_med_access_by   ON medical_access_log (tenant_id, accessed_by, created_at);

-- RLS на всі таблиці
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['medical_cards','allergy_tests','procedure_consents','coloring_formulas','medical_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON medical_cards, allergy_tests, procedure_consents, coloring_formulas, medical_access_log TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE medical_cards_id_seq, allergy_tests_id_seq, procedure_consents_id_seq, coloring_formulas_id_seq, medical_access_log_id_seq TO app_tenant;

COMMIT;
