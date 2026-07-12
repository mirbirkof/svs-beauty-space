-- 253: capacity-триггер не должен считать СОБСТВЕННУЮ пару брони (аудит v6, бронирование #1).
-- Поток бота: appointment создаётся ПЕРВЫМ, потом online_booking с appointment_id → в момент
-- INSERT брони её тень уже в appointments, а связь ob2.appointment_id ещё не видна (NEW не
-- вставлен). Триггер считал запись как чужую → ложный 23P01 → журнальная бронь молча терялась
-- (Mono-предоплата и история онлайн-канала отваливались).
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
       -- 253: собственная тень ЭТОЙ брони (связь в NEW ещё не видна таблице)
       AND a.id IS DISTINCT FROM NEW.appointment_id
  ) t;

  IF cnt >= cap THEN
    RAISE EXCEPTION 'ob_overlap: master % capacity % reached', NEW.master_id, cap
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
