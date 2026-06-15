-- MGT-10 Audit Log: право audit.read (просмотр журнала действий).
-- Только управляющие роли. owner = "*" уже покрывает.
UPDATE roles SET permissions = permissions || '["audit.read"]'::jsonb
  WHERE code IN ('admin','manager')
    AND NOT (permissions @> '["audit.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

-- Индексы для фильтров журнала (идемпотентно).
CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_log (entity);
CREATE INDEX IF NOT EXISTS idx_audit_user      ON audit_log (user_label);
