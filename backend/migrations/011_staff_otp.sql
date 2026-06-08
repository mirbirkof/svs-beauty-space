-- ═══════════════════════════════════════════════════════
-- 011_staff_otp.sql — Telegram-OTP логин для сотрудников
-- Заменяет статичный ADMIN_TOKEN на one-time коды через бот
-- ═══════════════════════════════════════════════════════

-- Привязка Telegram chat_id к юзеру (для доставки OTP-кодов)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='telegram_id') THEN
    ALTER TABLE users ADD COLUMN telegram_id BIGINT;
    CREATE INDEX idx_users_telegram ON users(telegram_id);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- One-time коды доставленные сотруднику
CREATE TABLE IF NOT EXISTS staff_otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,            -- SHA256 от 6-значного кода (не храним plain)
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON staff_otp_codes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON staff_otp_codes(expires_at);

-- Rate limit таблица (по phone+ip, окно 1 минута)
CREATE TABLE IF NOT EXISTS staff_otp_throttle (
  key         TEXT PRIMARY KEY,        -- 'phone:+38...' или 'ip:1.2.3.4'
  attempts    INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
