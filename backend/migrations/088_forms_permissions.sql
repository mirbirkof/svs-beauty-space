-- MGT-08 Forms: права forms.read / forms.write для управляющих ролей.
UPDATE roles SET permissions = permissions || '["forms.read","forms.write"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["forms.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

-- reception может смотреть и принимать ответы, но не редактировать конструктор.
UPDATE roles SET permissions = permissions || '["forms.read"]'::jsonb
  WHERE code IN ('reception','administrator')
    AND NOT (permissions @> '["forms.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
