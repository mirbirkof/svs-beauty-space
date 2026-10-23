-- 23.10.2026 (аудит «против интересов Босса», п.9): журнал действий (кто менял кассу/ціни/ЗП)
-- раз на добу ВИДАЛЯВСЯ старше 90 днів (lib/retention.js), а бекап живе 7 днів → історія губилась
-- назавжди. Тепер старі записи ПЕРЕНОСЯТЬСЯ сюди (одна транзакція: або в архіві, або лишилась у журналі).
-- Додавальна, ідемпотентна. Нічого не видаляє.
CREATE TABLE IF NOT EXISTS audit_log_archive (
  id          BIGINT PRIMARY KEY,           -- той самий id, що був у audit_log
  user_id     INTEGER,
  user_label  TEXT,
  action      TEXT,
  entity      TEXT,
  entity_id   INTEGER,
  ip          TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ,
  tenant_id   UUID,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_archive_created_idx ON audit_log_archive (created_at);
CREATE INDEX IF NOT EXISTS audit_log_archive_tenant_idx  ON audit_log_archive (tenant_id, created_at);

-- Ізоляція салонів — та сама політика, що в audit_log.
ALTER TABLE audit_log_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_archive FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'audit_log_archive'::regclass AND polname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON audit_log_archive
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
  END IF;
END $$;

-- Архів — лише читання для застосунку; анонімні ролі Supabase доступу не мають.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON audit_log_archive FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON audit_log_archive FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN EXECUTE 'REVOKE ALL ON audit_log_archive FROM app_tenant'; EXECUTE 'GRANT SELECT ON audit_log_archive TO app_tenant'; END IF;
END $$;
