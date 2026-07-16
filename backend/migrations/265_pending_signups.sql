-- 265: Подтверждение телефона при публичной регистрации (Босс 16.07.2026).
-- Регистрация НЕ создаёт тенант сразу — сначала верификация номера через Telegram
-- (request_contact, бесплатно). Данные заявки живут здесь до подтверждения.
-- Платформенная таблица (тенанта ещё нет) → БЕЗ RLS, но доступна роли app_tenant.
CREATE TABLE IF NOT EXISTS pending_signups (
  token           text PRIMARY KEY,
  phone           text NOT NULL,          -- введённый телефон (нормализованный, цифры)
  salon_name      text NOT NULL,
  owner_name      text,
  email           text,
  password_hash   text NOT NULL,          -- хеш, НЕ открытый пароль
  account_type    text NOT NULL DEFAULT 'salon',   -- salon | solo
  plan_code       text NOT NULL DEFAULT 'pro',
  cycle           text NOT NULL DEFAULT 'monthly',
  country         text,
  lang            text DEFAULT 'uk',
  ref_code        text,                   -- партнёрский реф
  consent         boolean NOT NULL DEFAULT false,
  consent_ip      text,
  -- верификация
  verified        boolean NOT NULL DEFAULT false,
  verified_phone  text,                   -- телефон, который вернул Telegram
  tg_chat_id      bigint,
  tg_user_id      bigint,
  attempts        integer NOT NULL DEFAULT 0,   -- сколько раз делился «не тем» номером
  -- результат
  tenant_id       uuid,                   -- заполняется после createTenant (защита от дубля)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE INDEX IF NOT EXISTS ix_pending_signups_phone ON pending_signups (phone);
CREATE INDEX IF NOT EXISTS ix_pending_signups_expires ON pending_signups (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON pending_signups TO app_tenant;

-- ВАЖНО: таблица имеет колонку tenant_id (для отметки созданного салона), поэтому
-- ensure-rls.js авто-включил бы tenant_isolation и сломал INSERT заявки (tenant_id=NULL
-- в контексте дефолтного тенанта → new row violates RLS). Явно держим RLS ВЫКЛ; в
-- ensure-rls.js pending_signups добавлена в PLATFORM_MANAGED (исключение). Доступ — по token.
DROP POLICY IF EXISTS tenant_isolation ON pending_signups;
ALTER TABLE pending_signups DISABLE ROW LEVEL SECURITY;
