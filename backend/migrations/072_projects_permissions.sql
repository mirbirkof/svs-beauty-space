-- 072_projects_permissions.sql
-- MGT-02: роути /api/projects/* вимагають projects.read / projects.write.
-- owner='*' уже покриває. Ідемпотентно.

UPDATE roles SET permissions = permissions || '["projects.read","projects.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["projects.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["projects.read","projects.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["projects.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["projects.read"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["projects.read"]'::jsonb);
