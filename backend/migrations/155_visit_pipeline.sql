-- 155: CRM-08 Visit Pipeline — лог переходів стадій, конфіг стадій (SLA/колір),
-- настроювані тригери. Прагматична single-salon модель: стадія = код статусу запису
-- (booked/confirmed/done/noshow/cancelled + віртуальні arrived/in_progress), без важкої
-- UUID-машинерії з кількома воронками. Повна сумісність з журналом/розкладом.
BEGIN;

-- ── 155.1 Конфіг стадій (накладка над статусами записів) ─────────────────────
CREATE TABLE IF NOT EXISTS visit_pipeline_stages (
  code         VARCHAR(30)  PRIMARY KEY,            -- booked|confirmed|arrived|in_progress|done|noshow|cancelled
  name         VARCHAR(100) NOT NULL,
  position     INTEGER      NOT NULL DEFAULT 0,
  color        VARCHAR(7)   DEFAULT '#6366f1',
  sla_minutes  INTEGER,                             -- макс. час у стадії (NULL = без SLA)
  is_terminal  BOOLEAN      NOT NULL DEFAULT FALSE,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- сід базових стадій (idempotent)
INSERT INTO visit_pipeline_stages (code, name, position, color, sla_minutes, is_terminal) VALUES
  ('booked',     'Заплановані',  0, '#6366f1', 1440, FALSE),
  ('confirmed',  'Підтверджені', 1, '#0ea5e9', 120,  FALSE),
  ('arrived',    'Прийшли',      2, '#f59e0b', 15,   FALSE),
  ('in_progress','В роботі',     3, '#8b5cf6', NULL, FALSE),
  ('done',       'Завершені',    4, '#16a34a', NULL, TRUE),
  ('noshow',     'Не прийшли',   5, '#dc2626', NULL, TRUE),
  ('cancelled',  'Скасовані',    6, '#94a3b8', NULL, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ── 155.2 Лог переходів стадій візита ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS visit_stage_log (
  id               SERIAL       PRIMARY KEY,
  appointment_id   INTEGER      NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  stage_code       VARCHAR(30)  NOT NULL,
  entered_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  exited_at        TIMESTAMPTZ,
  duration_seconds INTEGER,
  transitioned_by  TEXT,                            -- NULL = авто
  transition_reason VARCHAR(255),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_vsl_appointment ON visit_stage_log (appointment_id, entered_at);
CREATE INDEX IF NOT EXISTS ix_vsl_stage ON visit_stage_log (stage_code, entered_at);

-- ── 155.3 Тригери стадій ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visit_stage_triggers (
  id            SERIAL       PRIMARY KEY,
  stage_code    VARCHAR(30)  NOT NULL,
  trigger_type  VARCHAR(30)  NOT NULL CHECK (trigger_type IN ('notification','task','checklist','webhook','event')),
  trigger_on    VARCHAR(20)  NOT NULL DEFAULT 'enter' CHECK (trigger_on IN ('enter','exit','sla_breach')),
  delay_minutes INTEGER      NOT NULL DEFAULT 0,
  config        JSONB        NOT NULL DEFAULT '{}',   -- {template_id, channel, task_template, url}
  conditions    JSONB        DEFAULT '{}',            -- {vip_only, service_ids}
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_vst_stage ON visit_stage_triggers (stage_code, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON visit_pipeline_stages, visit_stage_log, visit_stage_triggers TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE visit_stage_log_id_seq, visit_stage_triggers_id_seq TO app_tenant;

COMMIT;
