-- 122: повний профіль Telegram у картці клієнта.
-- Раніше зберігали лише telegram_id + name(first_name). Тепер — прізвище та @username,
-- щоб упізнавати клієнта і звертатись на імʼя без повторного запиту контакту.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_username   TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_last_name  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_first_name TEXT;
