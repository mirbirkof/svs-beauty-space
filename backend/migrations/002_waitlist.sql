-- Waitlist: единая очередь на онлайн-запись из бота и сайта
-- BeautyPro API НЕ имеет endpoint waitlist (проверено 2026-06-07), ведём локально

CREATE TABLE IF NOT EXISTS waitlist (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  client_phone    TEXT NOT NULL,
  client_name     TEXT,
  service_id      TEXT NOT NULL,           -- BeautyPro service GUID
  service_name    TEXT,
  master_id       TEXT,                    -- BeautyPro employee GUID или NULL = любой
  master_name     TEXT,
  preferred_from  TIMESTAMPTZ NOT NULL,    -- желаемое окно "с"
  preferred_to    TIMESTAMPTZ NOT NULL,    -- желаемое окно "до"
  channel         TEXT NOT NULL,           -- 'bot' | 'site_salon' | 'site_shop' | 'admin'
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | offered | confirmed | cancelled | expired
  offered_slot    TIMESTAMPTZ,             -- предложенное время (когда освободилось)
  offered_at      TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  appointment_id  TEXT,                    -- BeautyPro appointment ID после подтверждения
  telegram_id     BIGINT,                  -- для уведомления о свободном слоте
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_phone ON waitlist(client_phone);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_service ON waitlist(service_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_window ON waitlist(preferred_from, preferred_to);

-- Единый журнал онлайн-записей (бот + сайт + магазин)
-- Позволяет видеть полную историю клиента по телефону
CREATE TABLE IF NOT EXISTS online_bookings (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  client_phone    TEXT NOT NULL,
  client_name     TEXT,
  service_id      TEXT NOT NULL,
  service_name    TEXT,
  master_id       TEXT,
  master_name     TEXT,
  date_from       TIMESTAMPTZ NOT NULL,
  date_to         TIMESTAMPTZ NOT NULL,
  channel         TEXT NOT NULL,           -- 'bot' | 'site_salon' | 'site_shop' | 'admin'
  bp_appointment_id TEXT,                  -- ID из BeautyPro
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed | no_show
  source_token    TEXT,                    -- токен из booking flow
  telegram_id     BIGINT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_phone ON online_bookings(client_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON online_bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON online_bookings(date_from, date_to);
CREATE INDEX IF NOT EXISTS idx_bookings_channel ON online_bookings(channel);
