-- 298_schedule_staff.sql — явний склад графіка роботи (нотатки #153, #154)
--
-- ПРОБЛЕМА, яку лікуємо:
-- Хто саме потрапляє в графік, досі ВИРАХОВУВАЛОСЬ здогадкою: active=true
-- + (provides_services OR staff_role='admin') + дедуплікація за схожим імʼям.
-- Наслідки: звільненого не прибрати (якщо десь лишився active), потрібну людину
-- не додати, а «двійники» з однаковим імʼям зникали з графіка мовчки.
--
-- РІШЕННЯ: склад графіка — це ЯВНИЙ список (masters.in_schedule), яким керує
-- власник/адмін прямо в розділі «Графік роботи». Нічого не вгадуємо.
-- Початкове значення = поточний фактичний склад, тож графік не змінюється в мить міграції.

ALTER TABLE masters ADD COLUMN IF NOT EXISTS in_schedule BOOLEAN;

-- Стартовий склад = та сама умова, за якою графік працював досі.
-- Звільнені (status='fired') і неактивні в склад не потрапляють у жодному разі.
UPDATE masters
   SET in_schedule = (
         active = true
         AND COALESCE(status, 'active') <> 'fired'
         AND (COALESCE(provides_services, true) = true OR staff_role = 'admin')
       )
 WHERE in_schedule IS NULL;

-- Звільнений не може лишатись у графіку навіть якщо колись був доданий вручну.
UPDATE masters SET in_schedule = false
 WHERE COALESCE(status, 'active') = 'fired' OR active = false;

-- Двійники за іменем: досі їх ховала дедуплікація в коді. Щоб склад графіка після
-- міграції збігся з тим, що Бос бачить на екрані, «порожнього» двійника (без записів,
-- без рядків графіка ззовні і без звʼязку зі старою CRM) у склад не беремо.
-- З бази НІЧОГО не видаляємо — людина лишається в команді, просто не в графіку.
WITH norm AS (
  SELECT id, tenant_id,
         lower(regexp_replace(COALESCE(name, ''), '\s+', ' ', 'g')) AS nk,
         (SELECT COUNT(*) FROM appointments a WHERE a.master_id = m.id) AS appt_cnt,
         (SELECT COUNT(*) FROM master_schedule_days d
           WHERE d.master_id = m.id AND d.source IS DISTINCT FROM 'manual') AS ext_cnt,
         legacy_ref
    FROM masters m
   WHERE in_schedule = true
), weak AS (
  SELECT id, tenant_id, nk,
         (appt_cnt = 0 AND ext_cnt = 0 AND legacy_ref IS NULL) AS is_weak
    FROM norm
)
UPDATE masters SET in_schedule = false
 WHERE id IN (
   SELECT w.id FROM weak w
    WHERE w.is_weak
      AND EXISTS (SELECT 1 FROM weak s
                   WHERE s.tenant_id = w.tenant_id AND s.nk = w.nk
                     AND s.id <> w.id AND NOT s.is_weak)
 );

ALTER TABLE masters ALTER COLUMN in_schedule SET DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_masters_in_schedule ON masters (in_schedule) WHERE in_schedule = true;
