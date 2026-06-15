-- COM-10: право reviews.moderate.
UPDATE roles SET permissions = permissions || '["reviews.moderate"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["reviews.moderate"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
