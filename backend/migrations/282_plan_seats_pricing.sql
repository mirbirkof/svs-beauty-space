-- 282: Тарифікація по «кріслах» + закриття безлімітної діри в solo-планах (SaaS-аудит 27.07)
--
-- ПРОБЛЕМА 1 (пряма втрата грошей): у планів «Майстер PRO» (249₴) і «Майстер MAX» (449₴)
-- у plan_limits НЕ БУЛО ЖОДНОГО рядка. lib/plan-limits fail-open → відсутній ліміт = БЕЗЛІМІТ.
-- Тобто за 249₴ салон міг завести скільки завгодно майстрів. Тепер solo-плани мають крісла.
--
-- ПРОБЛЕМА 2 (шкодить салону і нам): max_clients був ЖОРСТКИМ — на 500-му клієнті салон
-- фізично не міг завести нового клієнта посеред робочого дня. Це найгірший вид жадібності:
-- ламає роботу в моменті → салон іде до конкурента. Гроші беремо за КРІСЛА (метрика доходу),
-- база клієнтів — м'який ліміт: попередження + апсейл, робота не блокується.
--
-- ПРИНЦИП «конкурентно, але не задарма»:
--   • крісло = майстер, який НАДАЄ ПОСЛУГИ (provides_services) → жорсткий ліміт, це наш дохід;
--   • адмін/ресепшн/бухгалтер крісло НЕ займають (у конкурентів часто займають) → max_employees;
--   • клієнти/послуги — м'яко, щоб не ламати роботу салону.
-- Наявні салони понад ліміт НЕ ламаються: enforcePlanLimit блокує лише СТВОРЕННЯ нового.

-- 1) Крісла для solo-планів (де лімітів не було зовсім)
INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_masters', 1, FALSE FROM saas_plans_v2 p WHERE p.slug = 'solo_pro'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_masters');

INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_employees', 2, FALSE FROM saas_plans_v2 p WHERE p.slug = 'solo_pro'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_employees');

-- MAX — майстер + помічник (2 крісла), інакше немає сенсу платити вдвічі більше за PRO
INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_masters', 2, FALSE FROM saas_plans_v2 p WHERE p.slug = 'solo_max'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_masters');

INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_employees', 4, FALSE FROM saas_plans_v2 p WHERE p.slug = 'solo_max'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_employees');

-- Клієнти для solo-планів: щедро і м'яко (конкурентна перевага, не блокує роботу)
INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_clients', 2000, TRUE FROM saas_plans_v2 p WHERE p.slug = 'solo_pro'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_clients');

INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
SELECT p.id, 'max_clients', 5000, TRUE FROM saas_plans_v2 p WHERE p.slug = 'solo_max'
  AND NOT EXISTS (SELECT 1 FROM plan_limits l WHERE l.plan_id = p.id AND l.limit_key = 'max_clients');

-- 2) База клієнтів — м'який ліміт у ВСІХ планах (попередження + апсейл, без блокування роботи)
UPDATE plan_limits SET is_soft = TRUE WHERE limit_key = 'max_clients' AND is_soft = FALSE;

-- 3) Послуги — теж м'яко: блокувати додавання послуги посеред роботи салону безглуздо
UPDATE plan_limits SET is_soft = TRUE WHERE limit_key = 'max_services' AND is_soft = FALSE;
