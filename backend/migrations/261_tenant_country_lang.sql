-- 261: страна и язык салона (регистрация, запрос Босса).
-- country — выбор при регистрации; lang — автоопределяется из браузера клиента (navigator.language).
BEGIN;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'uk';
COMMIT;
