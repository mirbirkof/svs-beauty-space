-- 228: защита от двойного онлайн-бронирования (предпродажный аудит 07.07.2026).
-- online_bookings — источник правды для бота записи. Проверка занятости и вставка
-- были неатомарны (check-then-insert) → два параллельных клиента бронировали один
-- слот у мастера. Ставим EXCLUDE-констрейнт: пересечение по времени для одного
-- мастера в одном тенанте среди confirmed невозможно на уровне БД.
-- История confirmed чистая (0 пересечений на момент миграции) — констрейнт встанет.
-- appointments НЕ трогаем: там 233 исторических пересечения из импорта BeautyPro
-- (все в прошлом, будущих 0), EXCLUDE упал бы; онлайн-канал защищён здесь.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.online_bookings
  DROP CONSTRAINT IF EXISTS ob_no_overlap_confirmed;

ALTER TABLE public.online_bookings
  ADD CONSTRAINT ob_no_overlap_confirmed
  EXCLUDE USING gist (
    tenant_id WITH =,
    master_id WITH =,
    tstzrange(date_from, date_to) WITH &&
  ) WHERE (status = 'confirmed' AND master_id IS NOT NULL AND date_to IS NOT NULL);
