-- 154: SAL-05 Shifts — шаблони змін, генерація/публікація графіка, обмін змінами, переробки.
-- Розширює staff_shifts (054) без поломки: додає тип зміни, планові години, прив'язку
-- до шаблону, опізнення/переробки. Додає shift_templates (ротації 2/2, 5/2, 3/3) і
-- shift_swaps (обмін змінами з ланцюжком погодження).
-- single-salon: integer SERIAL, посилання на masters(id), без tenant_id/RLS (як staff_shifts).
BEGIN;

-- ── 154.1 Розширення staff_shifts ───────────────────────────────────────────
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS shift_type    VARCHAR(20) DEFAULT 'full';   -- morning|evening|full|split|night
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS planned_hours DECIMAL(4,1);
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS template_id   INTEGER;
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS late_minutes  INTEGER DEFAULT 0;
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS overtime_hours DECIMAL(4,1) DEFAULT 0;
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS published_at  TIMESTAMPTZ;
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS confirmed_at  TIMESTAMPTZ;
-- status тепер: planned|published|confirmed|working|done|missed|cancelled

-- ── 154.2 Шаблони змін ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_templates (
  id               SERIAL       PRIMARY KEY,
  name             VARCHAR(200) NOT NULL,
  shift_type       VARCHAR(20)  NOT NULL DEFAULT 'full',  -- morning|evening|full|split|night
  start_time       TIME         NOT NULL DEFAULT '09:00',
  end_time         TIME         NOT NULL DEFAULT '21:00',
  planned_hours    DECIMAL(4,1),
  weekdays         INTEGER[]     DEFAULT '{}',            -- 0=Пн..6=Нд (для weekly)
  rotation_pattern VARCHAR(10)  DEFAULT 'weekly',         -- weekly|2/2|5/2|3/3|4/3
  position         VARCHAR(100),                          -- роль/спеціалізація (текст)
  min_staff        INTEGER      NOT NULL DEFAULT 1,
  branch_id        INTEGER,
  status           VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by       TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_shift_templates_status ON shift_templates (status);

-- ── 154.3 Обмін змінами (swap) з ланцюжком погодження ───────────────────────
CREATE TABLE IF NOT EXISTS shift_swaps (
  id              SERIAL       PRIMARY KEY,
  shift_id        INTEGER      NOT NULL REFERENCES staff_shifts(id) ON DELETE CASCADE,
  target_shift_id INTEGER      REFERENCES staff_shifts(id) ON DELETE SET NULL,
  requester_id    INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  acceptor_id     INTEGER      REFERENCES masters(id) ON DELETE SET NULL,
  reason          TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','approved','completed','rejected','cancelled')),
  accepted_at     TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  reject_reason   TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_shift_swaps_status ON shift_swaps (status);
CREATE INDEX IF NOT EXISTS ix_shift_swaps_shift ON shift_swaps (shift_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON shift_templates, shift_swaps TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE shift_templates_id_seq, shift_swaps_id_seq TO app_tenant;

COMMIT;
