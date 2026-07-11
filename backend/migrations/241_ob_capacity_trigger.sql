-- 241: відновлення захисту від подвійного бронювання (блокер B1).
-- Регрес: міграція 239 зняла EXCLUDE ob_no_overlap_confirmed заради овербукінгу,
-- але це прибрало захист ЗОВСІМ — навіть при max_parallel=1 два паралельні клієнти
-- проходили application-перевірку (TOCTOU) і сідали на один слот.
--
-- Простий EXCLUDE не вміє "дозволити до N перекриттів", тому ставимо тригер:
--   1) advisory xact-lock на (tenant, master) серіалізує паралельні брони одного
--      майстра → гонка check-then-insert зникає;
--   2) рахуємо активні confirmed-перекриття і відхиляємо, якщо >= max_parallel.
-- Помилку кидаємо кодом 23P01 (exclusion_violation) — застосунок ловить її так само,
-- як ловив старий констрейнт, і показує людяне "поставити паралельно?".

CREATE OR REPLACE FUNCTION ob_enforce_capacity() RETURNS trigger AS $$
DECLARE
  cap int;
  cnt int;
BEGIN
  IF NEW.status IS DISTINCT FROM 'confirmed' OR NEW.master_id IS NULL OR NEW.date_to IS NULL THEN
    RETURN NEW;
  END IF;

  -- серіалізуємо конкурентні брони цього ж майстра в цьому ж тенанті
  PERFORM pg_advisory_xact_lock(hashtext(COALESCE(NEW.tenant_id::text, '') || ':' || NEW.master_id));

  -- місткість майстра (дефолт 1, якщо не знайдено)
  SELECT COALESCE(MAX(m.max_parallel), 1) INTO cap
    FROM masters m WHERE m.id::text = NEW.master_id;
  IF cap IS NULL THEN cap := 1; END IF;

  SELECT count(*) INTO cnt
    FROM online_bookings ob
   WHERE ob.tenant_id = NEW.tenant_id
     AND ob.master_id = NEW.master_id
     AND ob.status = 'confirmed'
     AND ob.date_to IS NOT NULL
     AND tstzrange(ob.date_from, ob.date_to) && tstzrange(NEW.date_from, NEW.date_to)
     AND (TG_OP = 'INSERT' OR ob.id IS DISTINCT FROM NEW.id);

  IF cnt >= cap THEN
    RAISE EXCEPTION 'ob_overlap: master % capacity % reached', NEW.master_id, cap
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ob_enforce_capacity ON online_bookings;
CREATE TRIGGER trg_ob_enforce_capacity
  BEFORE INSERT OR UPDATE ON online_bookings
  FOR EACH ROW EXECUTE FUNCTION ob_enforce_capacity();
