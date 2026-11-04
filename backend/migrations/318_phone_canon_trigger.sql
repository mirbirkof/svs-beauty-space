-- 318 · Босс 04.11: «навіть якщо людина написала номер без +38 — CRM має вставити правильно, без дублів».
-- Корінь: телефон майстра/співробітника писали ~8 різних шляхів (картка, «Новий співробітник», імпорт, бот, застосунок),
-- частина без нормалізації → у базі '0935239086', '+380…'. Правило на рівні БД ловить УСІ шляхи разом.
-- Канон = '380XXXXXXXXX' без '+', як clients.phone і lib/phone.js normalizePhoneDb.
-- Український номер у будь-якому записі (0XX…, 80XX…, 9 цифр, +380…, з пробілами/дужками) → 380XXXXXXXXX.
-- Іноземні/нестандартні НЕ чіпаємо (лише прибираємо пробіли/дужки/дефіси) — щоб не скалічити номер (#107).
-- clients свідомо НЕ тут: там phone_bidx (сліпий індекс) рахує застосунок; clients пишуться через normalizePhoneDb.
CREATE OR REPLACE FUNCTION canon_phone_ua(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  d := regexp_replace(p, '\D', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  IF left(d,2) = '00' THEN d := substr(d,3); END IF;
  IF length(d) = 12 AND left(d,3) = '380' THEN RETURN d; END IF;
  IF length(d) = 11 AND left(d,2) = '80'  THEN RETURN '3' || d; END IF;
  IF length(d) = 10 AND left(d,1) = '0'   THEN RETURN '38' || d; END IF;
  IF length(d) = 9 AND left(p,1) <> '+'   THEN RETURN '380' || d; END IF;
  RETURN regexp_replace(btrim(p), '[\s()\-.]', '', 'g');
END $$;

CREATE OR REPLACE FUNCTION trg_canon_phone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone := canon_phone_ua(NEW.phone);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_masters_canon_phone ON masters;
CREATE TRIGGER trg_masters_canon_phone BEFORE INSERT OR UPDATE OF phone ON masters
  FOR EACH ROW EXECUTE FUNCTION trg_canon_phone();
DROP TRIGGER IF EXISTS trg_users_canon_phone ON users;
CREATE TRIGGER trg_users_canon_phone BEFORE INSERT OR UPDATE OF phone ON users
  FOR EACH ROW EXECUTE FUNCTION trg_canon_phone();

-- наявні рядки (лише ті, що реально змінюються; збігів з іншими рядками немає — перевірено 04.11)
UPDATE masters SET phone = phone WHERE phone IS NOT NULL AND phone IS DISTINCT FROM canon_phone_ua(phone);
UPDATE users   SET phone = phone WHERE phone IS NOT NULL AND phone IS DISTINCT FROM canon_phone_ua(phone);
