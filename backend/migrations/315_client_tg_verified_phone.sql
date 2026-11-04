-- 04.11 (Босс): майстер визначається автоматично за номером.
-- Запам'ятовуємо номер, ПІДТВЕРДЖЕНИЙ Telegram-контактом (requestContact, contact.user_id == from.id),
-- окремо від clients.phone (той може бути введений вручну). Якщо номер майстра додадуть у CRM пізніше,
-- мініапп повторно звірить цей номер — без повторного запиту.
-- Лише ADD COLUMN; наявні дані не змінюються. Ідемпотентна.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_verified_phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
