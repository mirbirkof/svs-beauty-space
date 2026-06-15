-- 080_quality_control_permissions.sql
-- MGT-05: /api/qc/* — qc.read / qc.write. owner='*' покриває. Ідемпотентно.

UPDATE roles SET permissions = permissions || '["qc.read","qc.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["qc.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["qc.read","qc.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["qc.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["qc.read","qc.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["qc.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["qc.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["qc.read"]'::jsonb);
