-- 033: CRM feedback notes — плавающая кнопка "Заметки" в админке.
-- Любой авторизованный пользователь оставляет заметку прямо из кабинета,
-- система запоминает с какой страницы (page_path + page_label).
-- Невыполненные "горят" (status='open'), выполненные уходят во вкладку
-- "Виконані" (status='done') с отметкой кто и когда закрыл.
BEGIN;

CREATE TABLE IF NOT EXISTS crm_notes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  body            TEXT NOT NULL,
  page_path       TEXT,                       -- pathname + hash, напр. /admin/index.html#journal
  page_label      TEXT,                       -- человекочитаемое имя страницы (document.title)
  status          TEXT NOT NULL DEFAULT 'open',  -- open | done
  created_by      INTEGER,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_by         INTEGER,
  done_by_name    TEXT,
  done_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_crm_notes_status
  ON crm_notes (status, created_at DESC);

-- RLS: изоляция по тенанту (как у всех таблиц, страховка если 015 не покрыла новую)
ALTER TABLE crm_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_notes;
CREATE POLICY tenant_isolation ON crm_notes
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- права рабочей роли приложения
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_notes TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE crm_notes_id_seq TO app_tenant;

COMMIT;
