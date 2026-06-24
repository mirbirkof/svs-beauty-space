-- 149: COM-09 Call Center / Телефония
-- Интеграция CRM с IP-телефонией: Binotel, Ringostat, Lirax, Twilio.
-- Журнал звонков, операторы/очереди, пропущенные + callback-задачи,
-- IVR-настройки, записи разговоров, чёрный список, статистика.
-- AI-09 AI Call Analysis (таблицы 066_) используется как связанный модуль —
-- эта миграция только добавляет telephony-слой, не дублирует анализ.
BEGIN;

-- ─── 149.1 Провайдеры телефонии ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_providers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_type     VARCHAR(20) NOT NULL CHECK (provider_type IN ('binotel','ringostat','lirax','twilio')),
  name              VARCHAR(100) NOT NULL,
  config            JSONB       NOT NULL DEFAULT '{}'::jsonb, -- api_key, api_secret, account_sid, etc. (хранить зашифрованными)
  webhook_url       TEXT,
  webhook_secret    TEXT,
  phone_numbers     TEXT[]      NOT NULL DEFAULT '{}',
  is_primary        BOOLEAN     NOT NULL DEFAULT true,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  status            VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (status IN ('online','degraded','offline','unknown')),
  status_checked_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_call_providers_tenant ON call_providers (tenant_id, is_active);

-- ─── 149.2 Внутренние номера (SIP-расширения) ───────────────────────────────

CREATE TABLE IF NOT EXISTS call_extensions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id      UUID        NOT NULL REFERENCES call_providers(id) ON DELETE CASCADE,
  employee_id      INTEGER,    -- FK -> employees / masters (integer, как в схеме)
  extension_number VARCHAR(10) NOT NULL,
  sip_login        VARCHAR(100),
  sip_password     TEXT,       -- хранить зашифрованным
  forward_number   VARCHAR(20),
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_call_extensions ON call_extensions (tenant_id, extension_number);
CREATE INDEX IF NOT EXISTS ix_call_extensions_provider ON call_extensions (provider_id);

-- ─── 149.3 IVR-меню ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ivr_menus (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id     UUID        REFERENCES call_providers(id) ON DELETE SET NULL,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  tree            JSONB       NOT NULL DEFAULT '{}'::jsonb, -- дерево IVR: узлы, действия, переходы
  audio_files     JSONB       NOT NULL DEFAULT '{}'::jsonb, -- map: node_id -> audio_file_url
  tts_texts       JSONB       NOT NULL DEFAULT '{}'::jsonb, -- map: node_id -> text для синтеза
  schedule_type   VARCHAR(20) NOT NULL DEFAULT 'always' CHECK (schedule_type IN ('always','work_hours','after_hours','holiday')),
  schedule_config JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  is_default      BOOLEAN     NOT NULL DEFAULT false,
  stats_entered   INTEGER     NOT NULL DEFAULT 0,
  stats_completed INTEGER     NOT NULL DEFAULT 0,
  stats_abandoned INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ivr_menus_tenant ON ivr_menus (tenant_id, is_active, is_default);

-- ─── 149.4 Записи разговоров ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_recordings (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- call_id ставится после создания calls (заполняется при обновлении)
  call_uuid              UUID        UNIQUE,       -- ссылка на calls.id (заполняется POST-factum)
  provider_recording_id  VARCHAR(200),
  storage_type           VARCHAR(20) NOT NULL DEFAULT 'provider' CHECK (storage_type IN ('provider','s3','local')),
  storage_url            TEXT,       -- URL записи (хранить зашифрованным)
  file_size_bytes        BIGINT,
  duration_sec           INTEGER,
  format                 VARCHAR(10) NOT NULL DEFAULT 'mp3',
  transcription          TEXT,       -- расшифровка (заполняется AI-09)
  transcription_status   VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (transcription_status IN ('pending','processing','completed','failed')),
  ai_summary             TEXT,
  ai_sentiment           VARCHAR(20) CHECK (ai_sentiment IN ('positive','neutral','negative')),
  retention_until        DATE,       -- GDPR: дата удаления
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_call_recordings_tenant ON call_recordings (tenant_id, created_at DESC);

-- ─── 149.5 Callback-заявки ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS callback_requests (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id        INTEGER,    -- FK -> clients (integer)
  phone            VARCHAR(20) NOT NULL,
  name             VARCHAR(200),
  source           VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (source IN ('ivr','website_widget','telegram_bot','manual')),
  priority         INTEGER     NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','called','answered','missed','cancelled')),
  assigned_to      INTEGER,    -- FK -> employees (integer)
  preferred_time   TIMESTAMPTZ,
  call_back_before TIMESTAMPTZ,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  max_attempts     INTEGER     NOT NULL DEFAULT 3,
  last_attempt_at  TIMESTAMPTZ,
  call_uuid        UUID,       -- ссылка на calls.id при успешном перезвоне
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_callback_requests_status ON callback_requests (tenant_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS ix_callback_requests_client ON callback_requests (tenant_id, client_id);

-- ─── 149.6 Журнал звонков ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id         UUID        REFERENCES call_providers(id) ON DELETE SET NULL,
  external_call_id    VARCHAR(200),
  direction           VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
  caller_number       VARCHAR(20) NOT NULL,
  called_number       VARCHAR(20) NOT NULL,
  client_id           INTEGER,    -- FK -> clients (integer); NULL если номер не опознан
  employee_id         INTEGER,    -- FK -> employees (оператор)
  branch_id           INTEGER,
  status              VARCHAR(20) NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','answered','missed','busy','voicemail','failed')),
  disposition         VARCHAR(30) CHECK (disposition IN ('appointment_created','info_request','complaint','callback','spam','other')),
  ivr_path            TEXT[]      NOT NULL DEFAULT '{}',
  queue_time_sec      INTEGER     NOT NULL DEFAULT 0,
  talk_time_sec       INTEGER     NOT NULL DEFAULT 0,
  total_time_sec      INTEGER     NOT NULL DEFAULT 0,
  is_recorded         BOOLEAN     NOT NULL DEFAULT false,
  recording_id        UUID        REFERENCES call_recordings(id) ON DELETE SET NULL,
  callback_request_id UUID        REFERENCES callback_requests(id) ON DELETE SET NULL,
  notes               TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at         TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Дедупликация по external_call_id + provider (UNIQUE только там где не NULL)
CREATE UNIQUE INDEX IF NOT EXISTS ux_calls_external ON calls (external_call_id, provider_id) WHERE external_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_calls_tenant_started  ON calls (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_calls_client          ON calls (tenant_id, client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_calls_employee        ON calls (tenant_id, employee_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_calls_status          ON calls (tenant_id, status);

-- Обратная ссылка из call_recordings на calls (заполняется после insert)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='call_recordings' AND column_name='call_uuid'
  ) THEN
    ALTER TABLE call_recordings ADD COLUMN call_uuid UUID UNIQUE;
  END IF;
END $$;

-- ─── 149.7 Чёрный список номеров ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_blacklist (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  phone      VARCHAR(20) NOT NULL,
  reason     TEXT,
  added_by   INTEGER,    -- FK -> employees
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_call_blacklist ON call_blacklist (tenant_id, phone);

-- ─── RLS на все таблицы ──────────────────────────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'call_providers',
    'call_extensions',
    'ivr_menus',
    'call_recordings',
    'callback_requests',
    'calls',
    'call_blacklist'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))
        WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))
    $p$, t);
  END LOOP;
END $$;

-- ─── GRANT-ы для app_tenant ──────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON
  call_providers,
  call_extensions,
  ivr_menus,
  call_recordings,
  callback_requests,
  calls,
  call_blacklist
TO app_tenant;

COMMIT;
