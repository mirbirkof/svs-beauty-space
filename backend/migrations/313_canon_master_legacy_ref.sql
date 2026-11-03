-- 313: canon_master_id() у живих БД досі посилався на masters.beautypro_id (BeautyPro відрізано,
-- колонку перейменовано в legacy_ref). Файл 248 у репо вже виправлено, але міграція 248 давно
-- позначена застосованою → функцію в БД ніхто не перевизначив. Наслідок: БУДЬ-ЯКИЙ INSERT в
-- online_bookings з master_id падав «column m.beautypro_id does not exist» (тригер
-- trg_aa_ob_canon_master) → онлайн-бронь (бот і міні-апка) відкочувалась цілком.
-- Лише перевизначення функції, дані не змінюються. Ідемпотентно.
CREATE OR REPLACE FUNCTION canon_master_id(mid text) RETURNS text AS $$
  SELECT COALESCE(
    (SELECT m.id::text FROM masters m
      WHERE m.id::text = regexp_replace(mid, '^mst-', '')
         OR m.legacy_ref::text = mid
      LIMIT 1),
    NULLIF(regexp_replace(mid, '^mst-', ''), ''));
$$ LANGUAGE sql STABLE;
