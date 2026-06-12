-- 022: таблица scheduled_notifications
-- Использовалась в routes/reminders.js и routes/repeat-visits.js, но НЕ была создана —
-- крон напоминаний падал с "relation does not exist".
-- UNIQUE (appointment_id, event) — дедупликация на уровне БД (закрывает race в NOT EXISTS + INSERT).

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id               BIGSERIAL PRIMARY KEY,
  appointment_id   TEXT NOT NULL,
  telegram_chat_id TEXT,
  client_phone     TEXT,
  event            TEXT NOT NULL,             -- remind_24h | remind_2h | feedback | repeat_visit
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | cancelled
  sent_at          TIMESTAMPTZ,
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scheduled_notifications_appt_event_key UNIQUE (appointment_id, event)
);

CREATE INDEX IF NOT EXISTS idx_sched_notif_pending
  ON scheduled_notifications (status, scheduled_at) WHERE status = 'pending';
