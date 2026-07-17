-- 274_dental_module.sql (18.07.2026, Jarvis)
-- Вертикаль СТОМАТОЛОГИЯ: одонтограмма (+append-only история), планы лечения
-- с этапами, зуботехническая лаборатория, снимки к зубам.
-- Анамнез/согласия НЕ дублируем — переиспользуется модуль medical (103):
-- medical_cards (allergies/chronic/medications JSONB) + procedure_consents.
-- Приём = обычный appointment. RLS-паттерн миграции 269.

CREATE TABLE IF NOT EXISTS dental_teeth (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id(),
  client_id  BIGINT NOT NULL,
  tooth_no   INT NOT NULL CHECK (tooth_no BETWEEN 11 AND 85 AND tooth_no % 10 BETWEEN 1 AND 8),
  status     TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN
             ('healthy','caries','filling','crown','implant','pulpitis','extracted','root','bridge','missing')),
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dteeth_client_tooth ON dental_teeth(client_id, tooth_no);
CREATE INDEX IF NOT EXISTS idx_dteeth_tenant ON dental_teeth(tenant_id, client_id);

-- append-only: история никогда не удаляется (закон CRM — данные не терять)
CREATE TABLE IF NOT EXISTS dental_tooth_history (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  client_id      BIGINT NOT NULL,
  tooth_no       INT NOT NULL,
  old_status     TEXT,
  new_status     TEXT NOT NULL,
  note           TEXT,
  appointment_id BIGINT,
  changed_by     TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dth_client ON dental_tooth_history(tenant_id, client_id, tooth_no, changed_at DESC);

CREATE TABLE IF NOT EXISTS dental_plans (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  client_id      BIGINT NOT NULL,
  title          TEXT NOT NULL,
  diagnosis      TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','in_progress','done','cancelled')),
  total_estimate NUMERIC(12,2),
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dplans_client ON dental_plans(tenant_id, client_id, status);

CREATE TABLE IF NOT EXISTS dental_plan_stages (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  plan_id        BIGINT NOT NULL,
  position       INT NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  description    TEXT,
  teeth          INT[] NOT NULL DEFAULT '{}',
  estimate       NUMERIC(12,2),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','done','skipped')),
  appointment_id BIGINT,           -- этап ↔ визит (обычный appointment)
  done_at        TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dstages_plan ON dental_plan_stages(tenant_id, plan_id, position);

CREATE TABLE IF NOT EXISTS dental_lab_orders (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id(),
  client_id         BIGINT NOT NULL,
  appointment_id    BIGINT,
  lab_name          TEXT NOT NULL,
  work_type         TEXT NOT NULL,   -- коронка/протез/винир/капа/інше
  teeth             INT[] NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','ready','fitted','redo','closed')),
  sent_at           TIMESTAMPTZ,
  due_date          DATE,
  ready_at          TIMESTAMPTZ,
  cost              NUMERIC(12,2),   -- себестоимость (расход кассы при sent)
  price             NUMERIC(12,2),   -- цена для клиента
  cash_operation_id BIGINT,          -- идемпотентность расхода
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dlab_tenant ON dental_lab_orders(tenant_id, status, due_date);

CREATE TABLE IF NOT EXISTS dental_tooth_files (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  client_id      BIGINT NOT NULL,
  tooth_no       INT,              -- NULL = общий снимок (панорамный)
  file_id        BIGINT,           -- файловый контур (files)
  url            TEXT,             -- либо прямая ссылка
  kind           TEXT NOT NULL DEFAULT 'xray' CHECK (kind IN ('xray','photo','doc')),
  appointment_id BIGINT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dtf_client ON dental_tooth_files(tenant_id, client_id, tooth_no);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dental_teeth','dental_tooth_history','dental_plans',
                           'dental_plan_stages','dental_lab_orders','dental_tooth_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;
