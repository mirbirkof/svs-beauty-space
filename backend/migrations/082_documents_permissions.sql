-- 082_documents_permissions.sql
-- MGT-06: /api/documents/* — documents.read / documents.write. owner='*' покриває. Ідемпотентно.

UPDATE roles SET permissions = permissions || '["documents.read","documents.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["documents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["documents.read","documents.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["documents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["documents.read","documents.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["documents.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["documents.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["documents.read"]'::jsonb);
