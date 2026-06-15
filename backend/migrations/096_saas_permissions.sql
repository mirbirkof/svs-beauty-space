-- SAS-04/05/10: право saas.read / saas.write (управление тарифами/лицензией/флагами).
-- Только владелец/админ. Чтение эффективных фич доступно шире через отдельный публичный helper.
UPDATE roles SET permissions = permissions || '["saas.read","saas.write"]'::jsonb
  WHERE code IN ('admin')
    AND NOT (permissions @> '["saas.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

-- saas.read (только чтение эффективных фич/тарифа) — всем рабочим ролям для UI.
UPDATE roles SET permissions = permissions || '["saas.read"]'::jsonb
  WHERE code IN ('manager','reception','administrator','master')
    AND NOT (permissions @> '["saas.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
