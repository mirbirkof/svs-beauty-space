-- 248: канонизация online_bookings.master_id (закрывает major аудита v7).
-- Проблема: каталог/виджет отдают id мастера как 'mst-<id>' или BeautyPro GUID,
-- и это значение попадало в online_bookings.master_id как есть. Журнал
-- (appointments.master_id) — всегда числовой. Из-за этого:
--   * advisory-ключи hashtext('mst-42') и hashtext('42') РАЗНЫЕ → web- и admin-
--     транзакции не сериализовались между собой;
--   * кросс-подсчёты 247 сравнивали 'mst-42' с '42' → всегда 0 (замок вхолостую).
-- Фикс в корне: канонизируем master_id ДО проверки ёмкости. BEFORE-триггер
-- (имя алфавитно РАНЬШЕ trg_ob_enforce_capacity — Postgres запускает BEFORE-триггеры
-- по имени) приводит NEW.master_id к m.id::text для ЛЮБОГО пути записи:
-- виджет, бот, waitlist, ручной SQL. Кросс-защита 247 начинает работать как задумано.

-- 1. Функция канонизации: 'mst-42' | '42' | BeautyPro GUID → m.id::text
CREATE OR REPLACE FUNCTION canon_master_id(mid text) RETURNS text AS $$
  SELECT COALESCE(
    (SELECT m.id::text FROM masters m
      WHERE m.id::text = regexp_replace(mid, '^mst-', '')
         OR m.beautypro_id::text = mid
      LIMIT 1),
    NULLIF(regexp_replace(mid, '^mst-', ''), ''));
$$ LANGUAGE sql STABLE;

-- 2. Одноразовая чистка существующих строк (включая '' → NULL)
UPDATE online_bookings
   SET master_id = canon_master_id(master_id)
 WHERE master_id IS NOT NULL
   AND master_id IS DISTINCT FROM canon_master_id(master_id);

-- 3. BEFORE-триггер канонизации на insert/update
CREATE OR REPLACE FUNCTION ob_canon_master() RETURNS trigger AS $$
BEGIN
  IF NEW.master_id IS NOT NULL THEN
    NEW.master_id := canon_master_id(NEW.master_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_aa_ob_canon_master ON online_bookings;
CREATE TRIGGER trg_aa_ob_canon_master
  BEFORE INSERT OR UPDATE OF master_id ON online_bookings
  FOR EACH ROW EXECUTE FUNCTION ob_canon_master();
