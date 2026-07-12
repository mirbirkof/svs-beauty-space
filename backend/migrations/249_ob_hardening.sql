-- 249: hardening online_bookings по итогам аудита v8.
--   1) индекс на master_id — capacity-триггеры 247 делают seq scan при каждой брони;
--   2) FK appointment_id → appointments(id) ON DELETE SET NULL — прямой DELETE записи
--      больше не оставляет висячую ссылку (иначе триггер считает несуществующую тень);
--   3) переписанный backfill канонизации master_id С ОБХОДОМ capacity-триггера:
--      UPDATE master_id дёргает ob_enforce_capacity (247), и на БД с массой броней
--      миграция 248 могла упасть с ob_overlap. skip_overbook='on' снимает риск.

-- 1. индекс под capacity-триггеры и пре-чек слота
CREATE INDEX IF NOT EXISTS idx_ob_master_status_dates
  ON online_bookings (master_id, status, date_from, date_to);

-- 2. FK с мягким обнулением (данные уже чистые — orphans=0)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ob_appointment_id_fkey') THEN
    ALTER TABLE online_bookings
      ADD CONSTRAINT ob_appointment_id_fkey
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. повторная канонизация с обходом capacity-триггера (идемпотентно; для fresh-БД/тенантов)
DO $$ BEGIN
  PERFORM set_config('app.skip_overbook', 'on', true);
  UPDATE online_bookings
     SET master_id = canon_master_id(master_id)
   WHERE master_id IS NOT NULL
     AND master_id IS DISTINCT FROM canon_master_id(master_id);
END $$;
