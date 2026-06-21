-- INF-05 — Security Center (доповнення).
-- Базова безпека вже є: вхід/2FA/refresh/сесії (012_auth_module), аудит-лог (008/086).
-- Тут — недостаючі підмодулі: Threat Detection (security_events),
-- IP-whitelist для адмін-операцій, налаштовувана політика паролів (per-tenant).
-- Усе ізольовано по tenant_id (RLS + FORCE). ID — SERIAL (узгоджено з кодовою базою).

-- 1) Security events (виявлення загроз: brute-force, підозрілий вхід, масовий експорт)
CREATE TABLE IF NOT EXISTS security_events (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  user_id      INTEGER,
  event_type   VARCHAR(64) NOT NULL,          -- brute_force/suspicious_login/data_export/rate_limit
  severity     VARCHAR(16) NOT NULL DEFAULT 'medium', -- low/medium/high/critical
  description  TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  ip_address   TEXT,
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by  INTEGER,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sec_events_type     ON security_events (tenant_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_events_open      ON security_events (tenant_id, created_at DESC) WHERE resolved = FALSE;

-- 2) IP whitelist для критичних операцій
CREATE TABLE IF NOT EXISTS ip_whitelist (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  ip_address   TEXT,                          -- конкретний IP
  cidr_range   TEXT,                          -- або підмережа CIDR
  description  VARCHAR(256),
  scope        VARCHAR(16) NOT NULL DEFAULT 'admin', -- admin/api/all
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER,
  expires_at   TIMESTAMPTZ,                    -- NULL = безстроково
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whitelist_tenant ON ip_whitelist (tenant_id, is_active);

-- 3) Політика паролів (per-tenant, один рядок на тенант)
CREATE TABLE IF NOT EXISTS password_policies (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() UNIQUE,
  min_length            INTEGER NOT NULL DEFAULT 8,
  require_uppercase     BOOLEAN NOT NULL DEFAULT TRUE,
  require_lowercase     BOOLEAN NOT NULL DEFAULT TRUE,
  require_digits        BOOLEAN NOT NULL DEFAULT TRUE,
  require_special       BOOLEAN NOT NULL DEFAULT FALSE,
  max_age_days          INTEGER NOT NULL DEFAULT 90,   -- 0 = без терміну
  history_count         INTEGER NOT NULL DEFAULT 5,
  lockout_attempts      INTEGER NOT NULL DEFAULT 5,
  lockout_duration_min  INTEGER NOT NULL DEFAULT 30,
  require_2fa           BOOLEAN NOT NULL DEFAULT FALSE,
  require_2fa_roles      TEXT[] NOT NULL DEFAULT ARRAY['owner','admin'],
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS на всі 3 таблиці (той самий шаблон, що 132/133)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['security_events','ip_whitelist','password_policies']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
  END LOOP;
END $$;

-- Право security.manage для адмінів (owner = "*" вже покриває)
UPDATE roles SET permissions = permissions || '["security.manage"]'::jsonb
  WHERE code IN ('admin')
    AND NOT (permissions @> '["security.manage"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
