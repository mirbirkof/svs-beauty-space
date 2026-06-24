-- 158: COM-08 Omnichannel — дотягування інбоксу оператора: теги діалогів, SLA
-- (дедлайн відповіді + час першої відповіді), CSAT (оцінка клієнта), пріоритет,
-- швидкі відповіді (quick replies), статус оператора (online/away/offline).
-- Мультитенант: tenant_id UUID DEFAULT current_tenant_id() + RLS (як решта omni_*).
BEGIN;

-- ── 158.1 Розширення діалогів ────────────────────────────────────────────────
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS tags             TEXT[];
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS priority         TEXT DEFAULT 'normal';  -- low|normal|high|urgent
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS sla_due_at       TIMESTAMPTZ;
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS csat_score       INTEGER;                 -- 1..5
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS csat_comment     TEXT;
ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS closed_at        TIMESTAMPTZ;

-- ── 158.2 Швидкі відповіді ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS omni_quick_replies (
  id         BIGSERIAL    PRIMARY KEY,
  tenant_id  UUID         NOT NULL DEFAULT current_tenant_id(),
  shortcut   TEXT         NOT NULL,           -- /hi, /price ...
  title      TEXT,
  body       TEXT         NOT NULL,
  category   TEXT,
  channel    TEXT,                            -- NULL = усі канали
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_omni_qr_tenant ON omni_quick_replies (tenant_id, active);

-- ── 158.3 Статус оператора ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS omni_operator_status (
  id          BIGSERIAL    PRIMARY KEY,
  tenant_id   UUID         NOT NULL DEFAULT current_tenant_id(),
  operator_id BIGINT       NOT NULL,
  operator_name TEXT,
  status      TEXT         NOT NULL DEFAULT 'offline',  -- online|away|offline
  active_chats INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, operator_id)
);

-- ── 158.4 RLS на нові таблиці (як omni_* у 136) ──────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['omni_quick_replies','omni_operator_status'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON omni_quick_replies, omni_operator_status TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE omni_quick_replies_id_seq, omni_operator_status_id_seq TO app_tenant;

COMMIT;
