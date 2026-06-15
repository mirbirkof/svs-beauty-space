-- 061 Booking settings — гибкие правила онлайн-записи (CRM-05)
-- Single-tenant: одна строка настроек id=1

CREATE TABLE IF NOT EXISTS booking_settings (
  id            SMALLINT PRIMARY KEY DEFAULT 1,
  min_lead_minutes   INTEGER NOT NULL DEFAULT 30,   -- мин. время до записи (за сколько минимум можно записаться)
  max_horizon_days   INTEGER NOT NULL DEFAULT 90,   -- макс. горизонт записи вперёд
  slot_step_minutes  INTEGER NOT NULL DEFAULT 15,   -- шаг сетки слотов
  prevent_double_booking BOOLEAN NOT NULL DEFAULT TRUE, -- запрет накладок одного мастера
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT booking_settings_singleton CHECK (id = 1)
);

INSERT INTO booking_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
