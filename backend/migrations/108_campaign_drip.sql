-- 108: MKT-03 Drip-цепочки + A/B. Расширяет blast-кампании (миграция 041)
-- до полноценных drip: последовательность шагов с задержками, условный выход
-- по конверсии, per-client enrollment-стейт, A/B-варианты на уровне шага.
BEGIN;

-- Тип кампании: blast (одноразовая, по умолчанию — обратная совместимость) / drip / trigger.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'blast';
-- Прекращать цепочку при конверсии клиента (запись/визит после входа в цепочку).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exit_on_conversion BOOLEAN DEFAULT TRUE;
-- Лимит частоты: не чаще N сообщений клиенту в неделю (NULL = без лимита; Hub доп. троттлит).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS frequency_cap_per_week INTEGER;

-- Шаги drip-цепочки. step_number 1-based. delay_hours — от входа в шаг (от предыдущего).
CREATE TABLE IF NOT EXISTS campaign_steps (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number    INTEGER NOT NULL,
  delay_hours    INTEGER NOT NULL DEFAULT 0,      -- задержка от предыдущего шага (или от старта для шага 1)
  channel        TEXT DEFAULT 'any',
  template_key   TEXT,
  body           TEXT,
  vars           JSONB DEFAULT '{}'::jsonb,
  -- условие отправки шага относительно момента входа в цепочку:
  -- none | converted | not_converted (clicked/not_clicked зарезервированы — нет трекинга кликов)
  condition_type TEXT NOT NULL DEFAULT 'none',
  -- A/B: массив вариантов [{variant:'A',body:'...',template_key:null,weight:0.5}, ...]; NULL = без A/B
  variants       JSONB,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_campaign_steps_cid ON campaign_steps(campaign_id, step_number);

-- Стейт прохождения клиента по цепочке.
CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id     INTEGER NOT NULL,
  current_step  INTEGER DEFAULT 0,               -- 0 = ещё не отправлен ни один шаг
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | exited | excluded
  exit_reason   TEXT,                            -- converted | unsubscribed | manual | no_channel
  variant       TEXT,                            -- стики A/B-вариант клиента (A/B/C/D)
  next_run_at   TIMESTAMPTZ,                     -- когда обрабатывать следующий шаг
  entered_at    TIMESTAMPTZ DEFAULT NOW(),
  last_step_at  TIMESTAMPTZ,
  converted_at  TIMESTAMPTZ,
  enqueued      INTEGER DEFAULT 0,               -- сколько шагов реально поставлено в Hub
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_camp_enroll_due ON campaign_enrollments(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_camp_enroll_cid ON campaign_enrollments(campaign_id, status);

-- RLS-изоляция тенанта (паттерн миграции 107).
ALTER TABLE campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_steps;
DROP POLICY IF EXISTS tenant_isolation ON campaign_enrollments;
CREATE POLICY tenant_isolation ON campaign_steps
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
CREATE POLICY tenant_isolation ON campaign_enrollments
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_steps, campaign_enrollments TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE campaign_steps_id_seq, campaign_enrollments_id_seq TO app_tenant;

COMMIT;
