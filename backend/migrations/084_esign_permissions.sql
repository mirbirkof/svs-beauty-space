-- 084_esign_permissions.sql
-- MGT-07: /api/esign/* — esign.read / esign.write. owner='*' покриває. Ідемпотентно.
-- Публічне підписання /api/esign/sign/:token — без прав (за токеном).

UPDATE roles SET permissions = permissions || '["esign.read","esign.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["esign.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["esign.read","esign.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["esign.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["esign.read","esign.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["esign.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["esign.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["esign.read"]'::jsonb);
