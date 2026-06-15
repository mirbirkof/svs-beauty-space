-- Omnichannel: права omnichannel.read / omnichannel.write.
UPDATE roles SET permissions = permissions || '["omnichannel.read","omnichannel.write"]'::jsonb
  WHERE code IN ('admin','manager','reception','administrator')
    AND NOT (permissions @> '["omnichannel.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
