-- 104: SAL-10 права medical.read / medical.write / medical.delete. GET=medical.read, мутації=medical.write,
-- видалення медкарти (GDPR)=medical.delete (лише admin). Майстер бачить (read) для перевірки протипоказань. Ідемпотентно.
UPDATE roles SET permissions = permissions || '["medical.read","medical.write","medical.delete"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["medical.delete"]'::jsonb);

UPDATE roles SET permissions = permissions || '["medical.read","medical.write"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["medical.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["medical.read","medical.write"]'::jsonb
  WHERE code = 'reception' AND NOT (permissions @> '["medical.write"]'::jsonb);

UPDATE roles SET permissions = permissions || '["medical.read","medical.write"]'::jsonb
  WHERE code = 'master' AND NOT (permissions @> '["medical.write"]'::jsonb);
