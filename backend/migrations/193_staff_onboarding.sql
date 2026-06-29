-- 193: Адаптація / атестація / навчання співробітників.
-- Чек-лист по кожному майстру: пункти адаптації новачка, навчання, атестації.
-- Керуючий бачить прогрес і що прострочено.
CREATE TABLE IF NOT EXISTS staff_onboarding (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  master_id    INTEGER NOT NULL,
  category     TEXT NOT NULL DEFAULT 'adaptation',  -- adaptation | training | attestation
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending | done
  due_date     DATE,
  done_at      TIMESTAMPTZ,
  done_by      TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_onboarding_master ON staff_onboarding(master_id, status);
