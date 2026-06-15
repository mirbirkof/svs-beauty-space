-- 078_surveys_permissions.sql
-- MGT-09: /api/surveys/* — surveys.read / surveys.write. owner='*' покриває. Ідемпотентно.
-- Публічні ендпоінти (/api/surveys/public/*) — без прав (заповнення клієнтом).

UPDATE roles SET permissions = permissions || '["surveys.read","surveys.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["surveys.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["surveys.read","surveys.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["surveys.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["surveys.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["surveys.read"]'::jsonb);
