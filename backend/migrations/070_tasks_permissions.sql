-- 070_tasks_permissions.sql
-- MGT-01: роути /api/tasks/* вимагають tasks.read / tasks.write.
-- Видаємо права ролям (owner='*' уже покриває все). Ідемпотентно.

-- АДМІН: повне керування задачами
UPDATE roles
  SET permissions = permissions || '["tasks.read","tasks.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["tasks.write"]'::jsonb);

-- МЕНЕДЖЕР: повне керування задачами
UPDATE roles
  SET permissions = permissions || '["tasks.read","tasks.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["tasks.write"]'::jsonb);

-- РЕЦЕПШЕН: створює/бачить задачі (поточна операційка)
UPDATE roles
  SET permissions = permissions || '["tasks.read","tasks.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["tasks.write"]'::jsonb);

-- МАЙСТЕР: бачить свої задачі (без редагування чужих)
UPDATE roles
  SET permissions = permissions || '["tasks.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["tasks.read"]'::jsonb);
