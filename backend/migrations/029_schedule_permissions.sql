-- 029_schedule_permissions.sql
-- RBAC-гэп: роуты /api/schedule/* вимагають schedule.read / schedule.write,
-- але ці права не видавались ЖОДНІЙ ролі (крім owner='*'). Через це реальний
-- адмін/менеджер не бачив ні журнал записів, ні графік змін майстрів.
-- Видаємо права згідно ролей. Ідемпотентно: додаємо лише якщо ще немає.

-- АДМІН: повне керування графіком (читання + редагування)
UPDATE roles
  SET permissions = permissions || '["schedule.read","schedule.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["schedule.write"]'::jsonb);

-- МЕНЕДЖЕР: керування графіком (читання + редагування)
UPDATE roles
  SET permissions = permissions || '["schedule.read","schedule.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["schedule.write"]'::jsonb);

-- РЕЦЕПШЕН: бачить графік (для запису клієнтів), без редагування
UPDATE roles
  SET permissions = permissions || '["schedule.read"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["schedule.read"]'::jsonb);

-- МАЙСТЕР: бачить графік (свій робочий час)
UPDATE roles
  SET permissions = permissions || '["schedule.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["schedule.read"]'::jsonb);
