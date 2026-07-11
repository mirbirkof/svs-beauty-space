-- Задача №1 (верификация раунд 2): унификация защиты овербукинга через ОДИН триггер.
-- Раніше захист вмістимості був розмазаний по 7 шляхах вставки в appointments; частина
-- (mobile.js, agent-tools.js) — БЕЗ захисту; посточкові advisory-локи дали 2 регреси.
-- Тепер один тригер BEFORE INSERT ловить УСІ шляхи на сервері, єдиним локом.
--
-- Правила:
--  • INSERT-only — UPDATE (зміна статусу arrived/done/paid, перенос) НЕ чіпаємо, інакше
--    233 історичних перетини з BP-імпорту ламали б оновлення.
--  • skip якщо статус нової брони cancelled/noshow (не займає слот) АБО GUC
--    app.skip_overbook='on' (адмін force_parallel + імпорт свідомо овербукають).
--  • advisory_xact_lock(hashtext(master_id::text)) — ТОЙ САМИЙ ключ, що в app-локах бота
--    (booking-bot) й адмінки (schedule) → усі канали серіалізуються на одному локі.
--  • рахуємо активні перетини (NOT IN cancelled,noshow) для цього майстра; якщо >= max_parallel
--    → RAISE 23P01 (exclusion_violation) — застосунок ловить його як старий констрейнт.

CREATE OR REPLACE FUNCTION appt_enforce_capacity() RETURNS trigger AS $$
DECLARE
  cap int;
  cnt int;
BEGIN
  IF NEW.status IN ('cancelled', 'noshow') OR NEW.master_id IS NULL
     OR NEW.starts_at IS NULL OR NEW.ends_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.skip_overbook', true) = 'on' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.master_id::text));

  SELECT COALESCE(MAX(m.max_parallel), 1) INTO cap FROM masters m WHERE m.id = NEW.master_id;
  IF cap IS NULL THEN cap := 1; END IF;

  SELECT count(*) INTO cnt
    FROM appointments a
   WHERE a.master_id = NEW.master_id
     AND a.status NOT IN ('cancelled', 'noshow')
     AND a.ends_at IS NOT NULL
     AND tstzrange(a.starts_at, a.ends_at) && tstzrange(NEW.starts_at, NEW.ends_at);

  IF cnt >= cap THEN
    RAISE EXCEPTION 'appt_overlap: master % capacity % reached', NEW.master_id, cap
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appt_enforce_capacity ON appointments;
CREATE TRIGGER trg_appt_enforce_capacity
  BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_enforce_capacity();
