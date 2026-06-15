-- INT-03 Webhooks: права integrations.read / integrations.write.
UPDATE roles SET permissions = permissions || '["integrations.read","integrations.write"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["integrations.write"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
