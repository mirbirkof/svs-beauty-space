-- ═══════════════════════════════════════════════════════
-- Нотатка #160 — «Чому перукар Відюк Юлія показується в Адміністрації?»
--
-- Причина в корені: ролі в даних просто НЕ БУЛО. Міграція 051 проставила staff_role
-- одноразово, а всі, кого завели після неї (16 карток на момент правки), лишались
-- зі staff_role = NULL. Кожен розділ CRM після цього домальовував роль сам:
-- журнал/каса — «не надає послуг = адмін», графік — за текстом спеціальності,
-- реєстр команди — за явною роллю. Тому одна й та сама людина в різних місцях
-- виявлялась то майстром, то адміністратором.
--
-- Тут: доводимо дані до стану «у кожного є явна роль» і закриваємо шлях, яким
-- порожня роль зʼявлялась знову. Нічого не видаляємо, наявні ролі не переписуємо.
-- ═══════════════════════════════════════════════════════

-- 1. Хто був без ролі — отримує її за посадою в картці (об'єктивна ознака).
UPDATE masters
   SET staff_role = CASE
         WHEN specialty ILIKE '%адмін%' OR specialty ILIKE '%админ%' OR specialty ILIKE '%admin%' THEN 'admin'
         WHEN specialty ILIKE '%власн%' OR specialty ILIKE '%владел%' OR specialty ILIKE '%owner%' THEN 'owner'
         ELSE 'master' END
 WHERE btrim(COALESCE(staff_role,'')) = '';

-- 2. Сторонні значення (регістр, пробіли, застарілі варіанти) зводимо до трьох ролей.
UPDATE masters
   SET staff_role = lower(btrim(staff_role))
 WHERE staff_role IS NOT NULL
   AND staff_role <> lower(btrim(staff_role))
   AND lower(btrim(staff_role)) IN ('master','admin','owner');

UPDATE masters
   SET staff_role = 'master'
 WHERE lower(btrim(COALESCE(staff_role,'master'))) NOT IN ('master','admin','owner');

-- 3. Новий співробітник більше не може зʼявитись без ролі.
ALTER TABLE masters ALTER COLUMN staff_role SET DEFAULT 'master';

-- 4. Захист від повторення: будь-який запис із порожньою або невідомою роллю
--    мовчки стає 'master'. Тригер (а не NOT NULL), щоб не зламати вже наявні
--    вставки, які колонку взагалі не згадують або передають NULL явно.
CREATE OR REPLACE FUNCTION masters_normalize_staff_role() RETURNS trigger AS $$
BEGIN
  NEW.staff_role := lower(btrim(COALESCE(NEW.staff_role, '')));
  IF NEW.staff_role NOT IN ('master','admin','owner') THEN
    NEW.staff_role := 'master';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_masters_staff_role ON masters;
CREATE TRIGGER trg_masters_staff_role
  BEFORE INSERT OR UPDATE OF staff_role ON masters
  FOR EACH ROW EXECUTE FUNCTION masters_normalize_staff_role();
