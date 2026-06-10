-- 017: M28 File Storage — единое хранилище файлов
BEGIN;

CREATE TABLE IF NOT EXISTS files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  file_name     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL,           -- относительный путь внутри uploads/
  entity_type   TEXT,                    -- 'client' | 'product' | 'order' | 'document' | ...
  entity_id     TEXT,
  owner_user_id INTEGER,
  is_public     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

-- дедуп: один и тот же файл внутри тенанта храним один раз
CREATE UNIQUE INDEX IF NOT EXISTS files_tenant_sha_key
  ON files (tenant_id, sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_entity ON files (tenant_id, entity_type, entity_id);

-- RLS (новые таблицы НЕ покрываются миграцией 015 — вешаем явно)
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
