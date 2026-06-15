-- INT-01/02: право управления API-ключами (только владелец/админ).
UPDATE roles SET permissions = permissions || '["apikeys.read","apikeys.write"]'::jsonb
  WHERE code IN ('admin')
    AND NOT (permissions @> '["apikeys.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
