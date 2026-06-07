-- Pending bookings: токены ожидающие подтверждения в Telegram
-- Раньше было in-memory, теперь persistent + общий между бот, сайт, магазин
CREATE TABLE IF NOT EXISTS booking_pending (
  token         TEXT PRIMARY KEY,
  service_id    TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  date_from     TEXT NOT NULL,
  date_to       TEXT NOT NULL,
  client_name   TEXT,
  channel       TEXT DEFAULT 'site_salon',
  tg_user_id    BIGINT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed | expired
  appointment_id TEXT,
  error         TEXT,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_pending_tg ON booking_pending(tg_user_id, status);
CREATE INDEX IF NOT EXISTS idx_booking_pending_status ON booking_pending(status);
