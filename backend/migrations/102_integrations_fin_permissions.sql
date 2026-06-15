-- INT-09/10: право accounting.read / accounting.write.
UPDATE roles SET permissions = permissions || '["accounting.read","accounting.write"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["accounting.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
