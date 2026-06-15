-- 076_incidents_permissions.sql
-- MGT-04: /api/incidents/* — incidents.read / incidents.write. owner='*' покриває. Ідемпотентно.

UPDATE roles SET permissions = permissions || '["incidents.read","incidents.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["incidents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["incidents.read","incidents.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["incidents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["incidents.read","incidents.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["incidents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["incidents.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["incidents.read"]'::jsonb);
