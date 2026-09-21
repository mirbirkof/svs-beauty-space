-- ═══════════════════════════════════════════════════════
-- 306 — «менеджер і рецепція перестають бути майстрами» (борг від 17.09)
--
-- ЩО БАЧИВ БОС: завів людину менеджером або на рецепцію — а в графіку й у розділі
-- «Команда» вона стоїть як МАЙСТЕР. Доступи при цьому правильні, клієнтів на неї
-- не записують (provides_services=false), тому це виглядало косметикою — але
-- у складі зміни й у реєстрі людина числиться не тією, ким є.
--
-- ПРИЧИНА В КОРЕНІ (знайдено за кодом, не за здогадом):
--   • routes/users.js при заведенні співробітника кладе в картку РІВНО код ролі
--     логіна: WORKING_ROLES = master | admin | manager | reception | owner.
--   • Міграція 303 поставила на masters тригер masters_normalize_staff_role(),
--     а в ньому список дозволених ролей був ЛИШЕ з трьох: master | admin | owner.
--     Усе інше тригер МОВЧКИ переписував на 'master'.
--   Тобто 'manager' і 'reception' гинули на льоту, в тій самій транзакції, що їх
--   створювала: код писав правильне значення, тригер його стирав.
--   303 не помилялась у намірі (закрити порожню роль) — вона просто не знала про
--   дві робочі ролі, які заводить users.js. Тут узгоджуємо словник в одному місці.
--
-- ЧОМУ СПИСОК ЗАШИТИЙ, А НЕ ЧИТАЄТЬСЯ З ТАБЛИЦІ roles: на roles увімкнено
-- FORCE ROW LEVEL SECURITY з поділом по тенантах. Підзапит із тригера в сесії
-- без app.tenant_id віддав би порожнечу — і роль знову б схлопнулась у 'master',
-- тільки вже непередбачувано. Явний список надійніший за динамічний.
--
-- НІЧОГО НЕ ВИДАЛЯЄМО. Наявні ролі не переписуємо, крім одного випадку —
-- відновлення саме тих карток, які довів до 'master' цей тригер (крок 2).
-- ═══════════════════════════════════════════════════════

-- ── 1. Тригер тепер знає всі п'ять робочих ролей салону ──────────────────────
-- Список свідомо дорівнює WORKING_ROLES у routes/users.js. Невідоме сміття
-- (регістр, пробіли, чужі значення) як і раніше зводиться до 'master' —
-- це безпечний типовий стан, він нікому не додає прав.
CREATE OR REPLACE FUNCTION masters_normalize_staff_role() RETURNS trigger AS $$
BEGIN
  NEW.staff_role := lower(btrim(COALESCE(NEW.staff_role, '')));
  IF NEW.staff_role NOT IN ('master','admin','owner','manager','reception') THEN
    NEW.staff_role := 'master';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Тригер перестворюємо явно: якщо його колись знімали руками — він повернеться.
DROP TRIGGER IF EXISTS trg_masters_staff_role ON masters;
CREATE TRIGGER trg_masters_staff_role
  BEFORE INSERT OR UPDATE OF staff_role ON masters
  FOR EACH ROW EXECUTE FUNCTION masters_normalize_staff_role();

-- ── 2. Повернути роль тим, кого тригер уже встиг схлопнути ──────────────────
-- Журнал, з якого відновлюємо: логін людини (users.role_id → roles.code). Саме
-- звідти users.js брав роль у момент створення картки, тож це не здогад, а те
-- саме джерело. Чіпаємо ЛИШЕ картки з усіма ознаками схлопування одночасно:
--   • до картки прив'язаний логін менеджера або рецепції;
--   • у картці стоїть 'master' (тобто значення підмінене);
--   • provides_services = false — саме так users.js створює НЕ майстра;
--   • у прайсі немає жодної послуги і немає жодного запису — людина фактично
--     не працює як майстер (той самий об'єктивний критерій, що й у міграції 302).
-- Справжнього майстра під ці умови не підвести: у нього provides_services=true.
UPDATE masters m
   SET staff_role = src.code,
       updated_at = NOW()
  FROM (
    SELECT DISTINCT ON (u.master_id) u.master_id, r.code
      FROM users u
      JOIN roles r ON r.id = u.role_id
                  AND r.tenant_id IS NOT DISTINCT FROM u.tenant_id
     WHERE u.master_id IS NOT NULL
       AND r.code IN ('manager','reception')
     ORDER BY u.master_id, COALESCE(r.level, 0) DESC, u.id
  ) src
 WHERE m.id = src.master_id
   AND m.merged_into IS NULL
   AND lower(btrim(COALESCE(m.staff_role, ''))) = 'master'
   AND COALESCE(m.provides_services, true) = false
   AND NOT EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM appointments   a  WHERE a.master_id  = m.id);
