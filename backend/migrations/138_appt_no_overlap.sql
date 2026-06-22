-- 138: exclusion-constraint против двойного бронирования (аудит 22.06, Critical #1).
--
-- Прикладная защита уже стоит (lib/booking-guard.js во всех путях создания/переноса).
-- Этот constraint — backstop от гонки: два одновременных запроса проходят проверку
-- «свободно?» и оба пишут в один слот. На уровне БД пересечение невозможно физически.
--
-- ВАЖНО про данные: на момент аудита у салона уже есть исторические пересечения
-- (реальные двойные брони, которые и выявил аудит). Строгий ADD CONSTRAINT на грязных
-- данных упал бы и сломал всю цепочку миграций. Поэтому ставим условно:
--   • нет пересечений (новый тенант / почищенные данные) → constraint добавляется;
--   • есть пересечения → WARNING + пропуск, деплой не падает. После ручного
--     разруливания конфликтов constraint доустанавливается отдельной миграцией.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE v_overlaps int;
BEGIN
  -- уже есть constraint? выходим
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appt_no_overlap') THEN
    RAISE NOTICE 'appt_no_overlap already exists, skip';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_overlaps FROM (
    SELECT 1
      FROM appointments a1
      JOIN appointments a2
        ON a1.master_id = a2.master_id AND a1.id < a2.id
       AND a1.status NOT IN ('cancelled','noshow')
       AND a2.status NOT IN ('cancelled','noshow')
       AND tstzrange(a1.starts_at, a1.ends_at) && tstzrange(a2.starts_at, a2.ends_at)
  ) t;

  IF v_overlaps > 0 THEN
    RAISE WARNING 'appointments: % overlapping pairs found → appt_no_overlap NOT added. Resolve overlaps, then run migration 139 to install the constraint. App-level guard (booking-guard.js) protects new bookings meanwhile.', v_overlaps;
  ELSE
    ALTER TABLE appointments
      ADD CONSTRAINT appt_no_overlap
      EXCLUDE USING gist (
        master_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      )
      WHERE (status NOT IN ('cancelled','noshow') AND master_id IS NOT NULL);
    RAISE NOTICE 'appt_no_overlap constraint installed';
  END IF;
END $$;
