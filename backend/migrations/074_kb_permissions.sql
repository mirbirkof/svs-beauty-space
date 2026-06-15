-- 074_kb_permissions.sql
-- MGT-03: /api/kb/* — kb.read (всі співробітники читають) / kb.write (адмін/менеджер ведуть).
-- owner='*' уже покриває. Ідемпотентно.

UPDATE roles SET permissions = permissions || '["kb.read","kb.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["kb.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["kb.read","kb.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["kb.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["kb.read"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["kb.read"]'::jsonb);

UPDATE roles SET permissions = permissions || '["kb.read"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["kb.read"]'::jsonb);
