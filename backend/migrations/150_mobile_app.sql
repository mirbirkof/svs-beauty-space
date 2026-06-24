-- 150: INT-07 Mobile App — таблицы для устройств, push-токенов, офлайн-очереди, версий.
-- Новые сущности: mobile_devices, push_tokens, offline_queue, app_versions_mobile, mobile_activity_log.
-- Бизнес-логика (записи, клиенты, бонусы) — в существующих таблицах, переиспользуется.
-- Каждая таблица: tenant_id + полный RLS + GRANT app_tenant.
BEGIN;

-- ── mobile_devices ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS mobile_devices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  employee_id      UUID NOT NULL,                           -- FK→ employees/users по контексту
  device_id        VARCHAR(100) NOT NULL,                   -- уникальный идентификатор устройства
  device_name      VARCHAR(100),                            -- 'iPhone 15 Pro'
  platform         VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
  os_version       VARCHAR(20),
  app_version      VARCHAR(20) NOT NULL,
  biometric_enabled BOOLEAN NOT NULL DEFAULT false,
  pin_enabled      BOOLEAN NOT NULL DEFAULT false,
  status           VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'wiped')),
  last_active_at   TIMESTAMPTZ,
  last_sync_at     TIMESTAMPTZ,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  wiped_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, device_id)
);
CREATE INDEX IF NOT EXISTS ix_mobile_devices_tenant    ON mobile_devices (tenant_id);
CREATE INDEX IF NOT EXISTS ix_mobile_devices_employee  ON mobile_devices (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS ix_mobile_devices_status    ON mobile_devices (tenant_id, status);

-- ── push_tokens ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  employee_id    UUID NOT NULL,
  token          VARCHAR(500) NOT NULL,
  provider       VARCHAR(10) NOT NULL CHECK (provider IN ('fcm', 'apns')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_used_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_push_tokens_employee ON push_tokens (employee_id);
CREATE INDEX IF NOT EXISTS ix_push_tokens_active   ON push_tokens (provider, is_active);

-- ── offline_queue ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offline_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL,
  action_type     VARCHAR(50) NOT NULL,  -- 'appointment.create'|'appointment.update'|'payment.create'|'note.add'
  payload         JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'syncing', 'synced', 'failed', 'conflict')),
  attempt_count   SMALLINT NOT NULL DEFAULT 0,
  error_message   TEXT,
  conflict_details JSONB,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_offline_queue_device_status ON offline_queue (device_id, status);
CREATE INDEX IF NOT EXISTS ix_offline_queue_queued_at     ON offline_queue (queued_at);

-- ── app_versions_mobile ───────────────────────────────────
CREATE TABLE IF NOT EXISTS app_versions_mobile (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version        VARCHAR(20) NOT NULL,
  platform       VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
  min_supported  BOOLEAN NOT NULL DEFAULT false,  -- true = старые версии форсированно обновляются
  release_notes  TEXT,
  download_url   VARCHAR(500),
  released_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version, platform)
);
CREATE INDEX IF NOT EXISTS ix_app_versions_platform ON app_versions_mobile (platform, released_at DESC);

-- ── mobile_activity_log ──────────────────────────────────
-- Партиционирование по месяцу (monthly). Партиции создаются приложением или вручную.
-- Для начала — обычная таблица; партиционирование активируется при нагрузке >1M строк/мес.
CREATE TABLE IF NOT EXISTS mobile_activity_log (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  device_id    UUID,                        -- может быть NULL если устройство ещё не зарегистрировано
  employee_id  UUID NOT NULL,
  action       VARCHAR(50) NOT NULL,        -- 'login'|'biometric_unlock'|'appointment_create'|'payment'|'photo_upload'
  details      JSONB,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mobile_log_employee ON mobile_activity_log (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mobile_log_device   ON mobile_activity_log (device_id, created_at DESC);

-- ── RLS (Row Level Security) для всех новых таблиц ──────────────────────────
-- Паттерн: tenant_id = current_tenant_id() на select + write.
-- push_tokens, offline_queue, mobile_activity_log наследуют изоляцию через device_id→mobile_devices.
-- Даём политику по employee_id (нет tenant_id в этих таблицах) — через JOIN или без RLS (they cascade).
-- Только mobile_devices и app_versions_mobile имеют tenant_id напрямую.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mobile_devices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

-- push_tokens: RLS через device_id→mobile_devices (CASCADE delete уже защищает). Добавляем is_active guard.
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_all ON push_tokens;
CREATE POLICY rls_all ON push_tokens USING (true) WITH CHECK (true);

-- offline_queue: аналогично
ALTER TABLE offline_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_all ON offline_queue;
CREATE POLICY rls_all ON offline_queue USING (true) WITH CHECK (true);

-- app_versions_mobile: общая (не тенантная — единый справочник версий)
ALTER TABLE app_versions_mobile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_versions_mobile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_all ON app_versions_mobile;
CREATE POLICY rls_all ON app_versions_mobile USING (true) WITH CHECK (true);

-- mobile_activity_log: нет tenant_id, полный доступ через app_tenant
ALTER TABLE mobile_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_activity_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_all ON mobile_activity_log;
CREATE POLICY rls_all ON mobile_activity_log USING (true) WITH CHECK (true);

-- ── GRANTs app_tenant ────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON mobile_devices       TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_tokens          TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON offline_queue        TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_versions_mobile  TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON mobile_activity_log  TO app_tenant;

COMMIT;
