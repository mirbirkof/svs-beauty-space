-- 123: стан розмовної онлайн-запису в Telegram-боті.
-- Один рядок на користувача. Зберігає крок діалогу (state) і накопичені вибори (data).
-- Переживає рестарт сервера і працює між інстансами Render (на відміну від in-memory).
CREATE TABLE IF NOT EXISTS booking_sessions (
  tg_user_id  BIGINT PRIMARY KEY,
  chat_id     BIGINT,
  state       TEXT NOT NULL DEFAULT 'idle',
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- авто-очистка застарілих сесій робиться запитом при старті діалогу (TTL 30 хв)
CREATE INDEX IF NOT EXISTS idx_booking_sessions_updated ON booking_sessions(updated_at);
