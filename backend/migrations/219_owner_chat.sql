-- Чат власника салону в його Telegram-боті: сюди йдуть щоденні зведення/алерти.
-- Привʼязка через одноразовий код з адмінки (команда /owner <код> боту).
ALTER TABLE tenant_bot_settings ADD COLUMN IF NOT EXISTS owner_chat_id BIGINT;
