-- ═══════════════════════════════════════════════════════
-- 012_auth_module.sql — Полноценный модуль авторизации
-- Логин/пароль (login|email|phone) + JWT + сессии + 2FA + audit
-- ═══════════════════════════════════════════════════════

-- Новые роли (Бухгалтер, Маркетолог, Клиент-как-юзер)
INSERT INTO roles (code, name, level, permissions) VALUES
  ('accountant', 'Бухгалтер',   50, '["cashbox.*","reports.*","payroll.*","clients.read","stock.read"]'::jsonb),
  ('marketer',   'Маркетолог',  35, '["clients.*","reports.read","promos.*","loyalty.*","export.read"]'::jsonb),
  ('client',     'Клієнт',      5,  '["self.*"]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Расширяем users
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
    ALTER TABLE users ADD COLUMN username TEXT UNIQUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email_verified') THEN
    ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone_verified') THEN
    ALTER TABLE users ADD COLUMN phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='failed_login_attempts') THEN
    ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='locked_until') THEN
    ALTER TABLE users ADD COLUMN locked_until TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_changed_at') THEN
    ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='two_factor_enabled') THEN
    ALTER TABLE users ADD COLUMN two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='two_factor_secret') THEN
    ALTER TABLE users ADD COLUMN two_factor_secret TEXT;       -- для TOTP (Google Authenticator)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='two_factor_channel') THEN
    ALTER TABLE users ADD COLUMN two_factor_channel TEXT;      -- 'email' | 'sms' | 'totp'
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Сессии (refresh tokens + device info)
-- ВАЖНО: имя user_sessions, т.к. sessions уже занято кабинетом клиентов
CREATE TABLE IF NOT EXISTS user_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,                  -- SHA256 от refresh token
  device_label       TEXT,                                  -- 'Chrome 122 / macOS' или кастом
  user_agent         TEXT,
  ip                 TEXT,
  remember_me        BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, revoked_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_user_sessions_hash ON user_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Восстановление пароля
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                          -- SHA256
  channel     TEXT NOT NULL,                                 -- 'email' | 'sms'
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(user_id, used_at);

-- 2FA коды (одноразовые, для email/sms)
CREATE TABLE IF NOT EXISTS two_factor_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  channel     TEXT NOT NULL,                                 -- 'email' | 'sms' | 'login_attempt'
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_2fa_user ON two_factor_codes(user_id, used_at);

-- История паролей (защита от повтора)
CREATE TABLE IF NOT EXISTS password_history (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id, created_at DESC);

-- Подозрительные попытки (для blocking)
CREATE TABLE IF NOT EXISTS auth_attempts (
  id          BIGSERIAL PRIMARY KEY,
  identifier  TEXT NOT NULL,                                 -- email|phone|username|ip
  kind        TEXT NOT NULL,                                 -- 'login' | 'reset' | 'verify_2fa'
  success     BOOLEAN NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attempts_ident ON auth_attempts(identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON auth_attempts(ip, created_at DESC);
