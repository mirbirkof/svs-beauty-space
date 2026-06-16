-- 114: INF-04 права. monitoring.read (просмотр здоровья/uptime/алертов) —
-- admin/manager/reception; monitoring.manage (health checks, alert rules, SLA, ack) — admin/manager.
UPDATE roles SET permissions = permissions || '["monitoring.read"]'::jsonb
  WHERE code IN ('admin','manager','reception')
    AND NOT (permissions @> '["monitoring.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

UPDATE roles SET permissions = permissions || '["monitoring.manage"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["monitoring.manage"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);
