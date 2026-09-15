-- 301_merge_duplicate_staff_cards.sql — одна людина = одна картка (нотатка #157)
--
-- ПРОБЛЕМА, яку лікуємо:
-- На екрані «Команда» Бос бачив ДВІ Аліни-адміністраторки. Причина не в екрані:
-- 19.07 разовий скрипт unify-admin-profiles видав кожному адміну БЕЗ master_id
-- НОВУ картку співробітника, не перевіривши, що картка цієї людини вже існує.
-- Так зʼявилися картки-порожнівки (Аліна, Юлія): логін висів на порожній картці,
-- а вся історія (графік, зміни, записи) лишалась на справжній. Реєстр команди
-- склеює людину лише через звʼязок «логін → картка», тому одна людина = два рядки.
--
-- РІШЕННЯ: явне поле merged_into — «ця картка обʼєднана в ту». Нічого не видаляємо:
-- порожнівка лишається в базі як історія, але зникає зі списків, а логін, участь
-- у графіку й телефон переїжджають на справжню картку.

ALTER TABLE masters ADD COLUMN IF NOT EXISTS merged_into INTEGER REFERENCES masters(id);

CREATE INDEX IF NOT EXISTS idx_masters_not_merged ON masters (id) WHERE merged_into IS NULL;

-- ── крок 1: знайти пари «порожнівка → справжня картка» ───────────────────────
-- Порожнівка = картка БЕЗ жодної історії: ні записів, ні графіка, ні змін,
-- ні продажів, ні звʼязку зі старою CRM. Такі картки не несуть даних.
CREATE TEMP TABLE _merge_pairs ON COMMIT DROP AS
WITH shell AS (
  SELECT m.id, m.tenant_id, m.phone, COALESCE(m.in_schedule,false) AS in_schedule,
         lower(regexp_replace(COALESCE(m.name,''), '\s+', ' ', 'g')) AS nk
    FROM masters m
   WHERE m.merged_into IS NULL
     AND m.legacy_ref IS NULL
     AND NOT EXISTS (SELECT 1 FROM appointments           x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM appointment_services   x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM master_schedule_days   x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM staff_shifts           x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM time_blocks            x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM salon_product_sales    x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM service_master_prices  x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM payroll_rules          x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM legacy_master_aliases  x WHERE x.master_id   = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_history       x WHERE x.employee_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_documents     x WHERE x.employee_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM employee_specializations x WHERE x.employee_id = m.id)
), keeper AS (
  SELECT m.id, m.tenant_id,
         lower(regexp_replace(COALESCE(m.name,''), '\s+', ' ', 'g')) AS nk
    FROM masters m
   WHERE m.merged_into IS NULL
)
-- та сама людина = той самий салон + те саме імʼя; лишаємо картку З ІСТОРІЄЮ,
-- приєднуємо порожнівку. Одна порожнівка → рівно одна справжня картка.
SELECT DISTINCT ON (s.id)
       s.id AS dup_id, k.id AS keep_id, s.in_schedule AS dup_in_schedule, s.phone AS dup_phone
  FROM shell s
  JOIN keeper k ON k.tenant_id IS NOT DISTINCT FROM s.tenant_id
               AND k.nk = s.nk AND k.id <> s.id
 WHERE s.nk <> ''
   AND k.id NOT IN (SELECT id FROM shell)  -- порожнівку в порожнівку не зливаємо
 ORDER BY s.id, k.id;

-- ── крок 2: перенести на справжню картку те, що встигло прирости до порожнівки ──
-- телефон (якщо у справжньої його не було)
UPDATE masters k SET phone = p.dup_phone, updated_at = NOW()
  FROM _merge_pairs p
 WHERE k.id = p.keep_id AND (k.phone IS NULL OR k.phone = '') AND p.dup_phone IS NOT NULL;

-- участь у графіку: якщо порожнівка була в графіку — у графіку лишається людина
UPDATE masters k SET in_schedule = true, updated_at = NOW()
  FROM _merge_pairs p
 WHERE k.id = p.keep_id AND p.dup_in_schedule
   AND k.active = true AND COALESCE(k.status,'active') <> 'fired';

-- логін переїжджає на справжню картку (інакше людина знову «роздвоїться»)
UPDATE users u SET master_id = p.keep_id, updated_at = NOW()
  FROM _merge_pairs p
 WHERE u.master_id = p.dup_id;

-- ── крок 3: погасити порожнівку (не видаляємо — ховаємо як обʼєднану) ─────────
UPDATE masters m
   SET merged_into = p.keep_id, active = false, in_schedule = false, updated_at = NOW()
  FROM _merge_pairs p
 WHERE m.id = p.dup_id;
