-- SAL-09 Portfolio: права portfolio.read / portfolio.write.
UPDATE roles SET permissions = permissions || '["portfolio.read","portfolio.write"]'::jsonb
  WHERE code IN ('admin','manager','master','reception','administrator')
    AND NOT (permissions @> '["portfolio.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
