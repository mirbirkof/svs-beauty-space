-- 304_staff_twin_guard.sql — «одна людина = одна картка» стає ПОСТІЙНИМ правилом (нотатка #161)
--
-- ЩО СКАЗАВ ВЛАСНИК: «одна аліна продубльована і зайва, незрозуміло звідки
-- матеріалізувалась друга».
--
-- ЗВІДКИ БРАЛАСЬ ДРУГА. 19.07 разовий скрипт, який роздавав співробітникам логіни,
-- створював НОВУ картку кожному, у кого логін ще не був привʼязаний — не перевіривши,
-- що картка цієї людини вже є. Так зʼявились картки-порожнівки: логін висів на порожній,
-- а графік, зміни й записи лишались на справжній. Реєстр показував двох людей.
--
-- Міграція 301 (нотатка #157) прибрала вже наявні двійники, АЛЕ вона разова: якщо новий
-- двійник зʼявиться завтра — його ніхто не помітить. Тут закриваємо це назавжди:
--   1) повторне прибирання двійників (те саме безпечне правило, що й у 301) — ловить усе,
--      що встигло зʼявитись після неї;
--   2) індекс, який робить пошук «чи є вже така людина» миттєвим — ним користується
--      перевірка при заведенні нового співробітника (routes/employees.js).
-- Нічого не видаляємо: порожнівка лишається в базі як історія, лише ховається зі списків.

-- ── 1. Повторне прибирання двійників ────────────────────────────────────────
-- Порожнівка = картка БЕЗ жодної історії: ні записів, ні графіка, ні змін, ні продажів,
-- ні звʼязку зі старою CRM. Такі картки не несуть даних, тому злиття безпечне.
CREATE TEMP TABLE _twin_pairs ON COMMIT DROP AS
WITH shell AS (
  SELECT m.id, m.tenant_id, m.phone, COALESCE(m.in_schedule,false) AS in_schedule,
         lower(regexp_replace(COALESCE(m.name,''), '\s+', ' ', 'g')) AS nk
    FROM masters m
   WHERE m.merged_into IS NULL
     AND m.legacy_ref IS NULL
     AND NOT EXISTS (SELECT 1 FROM appointments             x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM appointment_services     x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM master_schedule_days     x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM staff_shifts             x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM time_blocks              x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM salon_product_sales      x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM service_master_prices    x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM payroll_rules            x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM legacy_master_aliases    x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_history         x WHERE x.employee_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_documents       x WHERE x.employee_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_specializations x WHERE x.employee_id = m.id)
), keeper AS (
  SELECT m.id, m.tenant_id,
         lower(regexp_replace(COALESCE(m.name,''), '\s+', ' ', 'g')) AS nk
    FROM masters m
   WHERE m.merged_into IS NULL
)
SELECT DISTINCT ON (s.id)
       s.id AS dup_id, k.id AS keep_id, s.in_schedule AS dup_in_schedule, s.phone AS dup_phone
  FROM shell s
  JOIN keeper k ON k.tenant_id IS NOT DISTINCT FROM s.tenant_id
               AND k.nk = s.nk AND k.id <> s.id
 WHERE s.nk <> ''
   AND k.id NOT IN (SELECT id FROM shell)   -- порожнівку в порожнівку не зливаємо
 ORDER BY s.id, k.id;

UPDATE masters k SET phone = p.dup_phone, updated_at = NOW()
  FROM _twin_pairs p
 WHERE k.id = p.keep_id AND (k.phone IS NULL OR k.phone = '') AND p.dup_phone IS NOT NULL;

UPDATE masters k SET in_schedule = true, updated_at = NOW()
  FROM _twin_pairs p
 WHERE k.id = p.keep_id AND p.dup_in_schedule
   AND k.active = true AND COALESCE(k.status,'active') <> 'fired';

UPDATE users u SET master_id = p.keep_id, updated_at = NOW()
  FROM _twin_pairs p
 WHERE u.master_id = p.dup_id;

UPDATE masters m
   SET merged_into = p.keep_id, active = false, in_schedule = false, updated_at = NOW()
  FROM _twin_pairs p
 WHERE m.id = p.dup_id;

-- ── 2. Швидкий пошук «чи є вже людина з таким імʼям» ────────────────────────
-- Використовує перевірка при створенні співробітника: вона не дає завести другу
-- картку тій самій людині мовчки (повертає зрозумілу відмову з посиланням на наявну).
CREATE INDEX IF NOT EXISTS idx_masters_namekey_live
    ON masters (tenant_id, lower(regexp_replace(COALESCE(name,''), '\s+', ' ', 'g')))
 WHERE merged_into IS NULL;
