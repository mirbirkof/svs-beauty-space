-- 156: CRM-09 Employees — реєстр персоналу поверх існуючої masters (не дублюємо!).
-- masters = джерело правди по майстрах (звʼязка послуг = master_services 105). Тут
-- додаються кадрові поля + довідники (посади/відділи/спеціалізації) + документи + історія.
-- single-salon: integer SERIAL, посилання на masters(id). employee_services = master_services.
BEGIN;

-- ── 156.1 Кадрові поля в masters ────────────────────────────────────────────
ALTER TABLE masters ADD COLUMN IF NOT EXISTS email             VARCHAR(255);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(100);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS telegram_id       BIGINT;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS birth_date        DATE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS gender            VARCHAR(10);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS hire_date         DATE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS fire_date         DATE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS position_id       INTEGER;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS department_id     INTEGER;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS manager_id        INTEGER;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS branch_id         INTEGER;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS mastery_level     VARCHAR(20) DEFAULT 'junior';  -- trainee|junior|middle|senior|expert
ALTER TABLE masters ADD COLUMN IF NOT EXISTS status            VARCHAR(20) DEFAULT 'active';  -- active|vacation|sick|maternity|fired|training
ALTER TABLE masters ADD COLUMN IF NOT EXISTS rating            DECIMAL(3,2) DEFAULT 0;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS total_clients     INTEGER DEFAULT 0;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS repeat_rate       DECIMAL(5,2) DEFAULT 0;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS public_profile    BOOLEAN DEFAULT TRUE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS social_instagram  VARCHAR(255);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS social_tiktok     VARCHAR(255);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS sort_order        INTEGER DEFAULT 0;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW();

-- ── 156.2 Відділи / посади ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL       PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  parent_id  INTEGER      REFERENCES departments(id) ON DELETE SET NULL,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id            SERIAL       PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  department_id INTEGER      REFERENCES departments(id) ON DELETE SET NULL,
  level         INTEGER      NOT NULL DEFAULT 0,
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 156.3 Спеціалізації + привязка ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS specializations (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icon        VARCHAR(50),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_specializations (
  id                SERIAL      PRIMARY KEY,
  employee_id       INTEGER     NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  specialization_id INTEGER     NOT NULL REFERENCES specializations(id) ON DELETE CASCADE,
  level             VARCHAR(20) NOT NULL DEFAULT 'middle',  -- junior|middle|senior|expert
  certified_at      DATE,
  next_certification DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, specialization_id)
);
CREATE INDEX IF NOT EXISTS ix_emp_spec_employee ON employee_specializations (employee_id);

-- ── 156.4 Документи ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_documents (
  id          SERIAL       PRIMARY KEY,
  employee_id INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  doc_type    VARCHAR(50)  NOT NULL,   -- contract|certificate|medical|passport|nda
  title       VARCHAR(255) NOT NULL,
  file_url    VARCHAR(500),
  issued_at   DATE,
  expires_at  DATE,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active|expiring|expired
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_emp_docs_employee ON employee_documents (employee_id, expires_at);

-- ── 156.5 Історія / карʼєрний трек ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_history (
  id           SERIAL       PRIMARY KEY,
  employee_id  INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  event_type   VARCHAR(30)  NOT NULL,  -- hired|promoted|transferred|fired|returned|level_up
  details      JSONB        DEFAULT '{}',
  initiated_by TEXT,
  event_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_emp_history_employee ON employee_history (employee_id, event_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON departments, positions, specializations,
  employee_specializations, employee_documents, employee_history TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE departments_id_seq, positions_id_seq, specializations_id_seq,
  employee_specializations_id_seq, employee_documents_id_seq, employee_history_id_seq TO app_tenant;

COMMIT;
