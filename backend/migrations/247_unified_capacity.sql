-- 247: ЕДИНАЯ защита от овербукинга поверх ОБЕИХ таблиц (закрывает BLOCKER-R1/R2 + MAJOR-R2 раунда 3).
-- Проблемы, которые чинит:
--   1) 241 и 246 брали РАЗНЫЕ advisory-ключи (tenant:master vs master) → web-TX и admin-TX
--      не сериализовались между собой. Теперь ОДИН канонический ключ: hashtext(master_id::text)
--      — тот же, что в app-локах (booking-bot.js:469, schedule.js:1391).
--   2) Каждый триггер считал только СВОЮ таблицу → web-бронь не видела админ-запись и наоборот.
--      Теперь оба считают UNION обеих таблиц. Двойной счёт пары "бронь+её же тень в журнале"
--      исключён через НАСТОЯЩУЮ связь online_bookings.appointment_id (раньше связи не было вообще,
--      только текст в notes).
--   3) 246 был INSERT-only → reschedule (PATCH) обходил защиту. Теперь UPDATE OF starts_at/ends_at/
--      master_id тоже проверяется (смена статуса НЕ триггерит — исторические дубли не ломают done/cancel).
-- Обход для admin-force: SET LOCAL app.skip_overbook='on' (теперь симметрично в ОБОИХ триггерах).

-- 1. Реальная связь бронь → запись журнала
ALTER TABLE online_bookings ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_ob_appointment_id ON online_bookings(appointment_id);

-- 2. Бэкфилл существующих теней по текстовой метке 'Онлайн-запис #<id>'
UPDATE online_bookings ob
   SET appointment_id = a.id
  FROM appointments a
 WHERE ob.appointment_id IS NULL
   AND a.source = 'online'
   AND a.notes ~ ('^Онлайн-запис #' || ob.id || '([^0-9]|$)');

-- 3. online_bookings: единый ключ + кросс-подсчёт
CREATE OR REPLACE FUNCTION ob_enforce_capacity() RETURNS trigger AS $$
DECLARE
  cap int;
  cnt int;
BEGIN
  IF NEW.status IS DISTINCT FROM 'confirmed' OR NEW.master_id IS NULL
     OR NEW.date_from IS NULL OR NEW.date_to IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.skip_overbook', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- ЕДИНЫЙ канонический ключ (как бот, админ и триггер журнала)
  PERFORM pg_advisory_xact_lock(hashtext(NEW.master_id));

  SELECT COALESCE(MAX(m.max_parallel), 1) INTO cap
    FROM masters m WHERE m.id::text = NEW.master_id;
  IF cap IS NULL THEN cap := 1; END IF;

  SELECT count(*) INTO cnt FROM (
    SELECT ob.id FROM online_bookings ob
     WHERE ob.master_id = NEW.master_id
       AND ob.status = 'confirmed'
       AND ob.date_to IS NOT NULL
       AND tstzrange(ob.date_from, ob.date_to) && tstzrange(NEW.date_from, NEW.date_to)
       AND ob.id IS DISTINCT FROM NEW.id
    UNION ALL
    SELECT a.id FROM appointments a
     WHERE a.master_id::text = NEW.master_id
       AND a.status NOT IN ('cancelled', 'noshow')
       AND a.ends_at IS NOT NULL
       AND tstzrange(a.starts_at, a.ends_at) && tstzrange(NEW.date_from, NEW.date_to)
       -- тень активной брони не считаем второй раз (бронь уже посчитана выше)
       AND NOT EXISTS (SELECT 1 FROM online_bookings ob2
                        WHERE ob2.appointment_id = a.id AND ob2.status = 'confirmed')
  ) t;

  IF cnt >= cap THEN
    RAISE EXCEPTION 'ob_overlap: master % capacity % reached', NEW.master_id, cap
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ob_enforce_capacity ON online_bookings;
CREATE TRIGGER trg_ob_enforce_capacity
  BEFORE INSERT OR UPDATE OF date_from, date_to, master_id, status ON online_bookings
  FOR EACH ROW EXECUTE FUNCTION ob_enforce_capacity();

-- 4. appointments: кросс-подсчёт + защита reschedule
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

  SELECT count(*) INTO cnt FROM (
    SELECT a.id FROM appointments a
     WHERE a.master_id = NEW.master_id
       AND a.status NOT IN ('cancelled', 'noshow')
       AND a.ends_at IS NOT NULL
       AND tstzrange(a.starts_at, a.ends_at) && tstzrange(NEW.starts_at, NEW.ends_at)
       AND a.id IS DISTINCT FROM NEW.id
    UNION ALL
    -- web-брони, у которых ещё НЕТ тени в журнале (иначе двойной счёт)
    SELECT ob.id FROM online_bookings ob
     WHERE ob.master_id = NEW.master_id::text
       AND ob.status = 'confirmed'
       AND ob.date_to IS NOT NULL
       AND ob.appointment_id IS NULL
       AND tstzrange(ob.date_from, ob.date_to) && tstzrange(NEW.starts_at, NEW.ends_at)
  ) t;

  IF cnt >= cap THEN
    RAISE EXCEPTION 'appt_overlap: master % capacity % reached', NEW.master_id, cap
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appt_enforce_capacity ON appointments;
CREATE TRIGGER trg_appt_enforce_capacity
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, master_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_enforce_capacity();
