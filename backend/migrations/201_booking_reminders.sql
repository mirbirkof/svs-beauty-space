-- 201: нагадування про візити в Telegram (бот @Svs_beautybot, Етап 5)
-- Дедуп відправлених нагадувань: одне повідомлення на (запис, вид).
-- Таблиця службова, без tenant-колонки: appointment_id вже ізольований RLS-ом appointments.

CREATE TABLE IF NOT EXISTS booking_reminders (
  appointment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, kind)
);

-- прод-додаток працює під app_tenant (без прав CREATE у public) — видаємо доступ явно
GRANT SELECT, INSERT, DELETE ON booking_reminders TO app_tenant;
