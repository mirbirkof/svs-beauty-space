-- 239_master_max_parallel.sql
-- Фіча: паралельні записи в одного майстра (овербукінг).
-- Наприклад, поки в одного клієнта «схоплюється» фарба, майстер починає другого.
--
-- Вводимо ВМІСТИМІСТЬ майстра: скільки клієнтів одночасно він веде.
-- DEFAULT 1 = поточна поведінка (жодного регресу): слот зайнятий однією активною
-- записою. Власник у картці майстра може підняти до 2+, і тоді на той самий час
-- дозволяється відповідна кількість записів.
ALTER TABLE masters ADD COLUMN IF NOT EXISTS max_parallel INT NOT NULL DEFAULT 1;
-- ідемпотентно: на primary констрейнт уже додано ad-hoc (10.07), повторний прогін не має падати
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'masters_max_parallel_chk') THEN
    ALTER TABLE masters ADD CONSTRAINT masters_max_parallel_chk CHECK (max_parallel >= 1) NOT VALID;
  END IF;
END $$;

-- Фізичний EXCLUDE на online_bookings забороняв будь-яке перекриття confirmed-записів,
-- що робило паралельні брони неможливими навіть у публічному каналі. Прибираємо його —
-- контроль вмістимості тепер на рівні застосунку (count < max_parallel). Овербукінг —
-- це навмисна поведінка, тому жорсткий БД-заборонник тут зайвий.
ALTER TABLE online_bookings DROP CONSTRAINT IF EXISTS ob_no_overlap_confirmed;
