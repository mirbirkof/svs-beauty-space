-- 081: MGT-06 Документообіг — реєстр документів, версіонування, шаблони з полями,
-- коментарі, контроль строків. Фізичне зберігання файлів — у таблиці files (M28),
-- тут лише метадані + посилання file_storage_id -> files.id. Прагматика під один салон:
-- BIGSERIAL id, tenant_id UUID + RLS (як 077/079), integer client/employee/supplier/visit.
-- Дедуп по file_hash. FTS — full_text_index TSVECTOR (укр+рос словники недоступні -> simple).
BEGIN;

-- 081.1 Документи
CREATE TABLE IF NOT EXISTS documents (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id       INTEGER,
  category        TEXT NOT NULL DEFAULT 'other',  -- contract|act|invoice|order|regulation|certificate|other
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  file_storage_id BIGINT,                          -- -> files.id (фізичний файл)
  file_name       TEXT,
  file_size       BIGINT,
  mime_type       TEXT,
  file_hash       TEXT,                            -- SHA-256 для дедупу
  current_version INTEGER NOT NULL DEFAULT 1,
  client_id       INTEGER,
  employee_id     INTEGER,
  supplier_id     INTEGER,
  visit_id        INTEGER,
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at      DATE,
  expiry_notified JSONB NOT NULL DEFAULT '[]'::jsonb, -- масив порогів, по яких вже сповіщено: [30,14,7,1]
  status          TEXT NOT NULL DEFAULT 'active',  -- active|archived|expired|deleted
  is_template_generated BOOLEAN NOT NULL DEFAULT FALSE,
  template_id     BIGINT,
  esign_status    TEXT,                            -- NULL|pending|signed|rejected
  locked_by       INTEGER,
  locked_at       TIMESTAMPTZ,
  full_text_index TSVECTOR,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_docs_tenant   ON documents (tenant_id, category, status);
CREATE INDEX IF NOT EXISTS ix_docs_client   ON documents (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS ix_docs_employee ON documents (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS ix_docs_expires  ON documents (tenant_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_docs_hash     ON documents (tenant_id, file_hash);
CREATE INDEX IF NOT EXISTS ix_docs_fts      ON documents USING GIN (full_text_index);

-- 081.2 Версії документів
CREATE TABLE IF NOT EXISTS document_versions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  file_storage_id BIGINT,
  file_name       TEXT,
  file_size       BIGINT,
  mime_type       TEXT,
  comment         TEXT NOT NULL DEFAULT '',
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_number)
);
CREATE INDEX IF NOT EXISTS ix_docver_doc ON document_versions (document_id, version_number DESC);

-- 081.3 Коментарі до документа
CREATE TABLE IF NOT EXISTS document_comments (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id   INTEGER,
  author_name TEXT,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_doccmt_doc ON document_comments (document_id, created_at DESC);

-- 081.4 Шаблони документів
CREATE TABLE IF NOT EXISTS document_templates (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT 'other',  -- contract|consent|act|invoice|other
  output_format    TEXT NOT NULL DEFAULT 'pdf',    -- pdf|docx
  template_file_id BIGINT,
  body_html        TEXT NOT NULL DEFAULT '',
  language         TEXT NOT NULL DEFAULT 'uk',
  version          INTEGER NOT NULL DEFAULT 1,
  is_system        BOOLEAN NOT NULL DEFAULT FALSE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_doctpl_tenant ON document_templates (tenant_id, category, active);

-- 081.5 Поля шаблону
CREATE TABLE IF NOT EXISTS document_template_fields (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id    BIGINT NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  field_key      TEXT NOT NULL,                    -- напр. "client.full_name"
  field_label    TEXT NOT NULL,
  field_type     TEXT NOT NULL DEFAULT 'text',     -- text|date|number|currency|list
  source_entity  TEXT,                             -- client|employee|supplier|visit|manual
  source_field   TEXT,
  is_required    BOOLEAN NOT NULL DEFAULT FALSE,
  default_value  TEXT,
  format_pattern TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, field_key)
);
CREATE INDEX IF NOT EXISTS ix_doctplf_tpl ON document_template_fields (template_id, sort_order);

-- FTS-тригер: оновлення full_text_index з title+description+file_name+tags
CREATE OR REPLACE FUNCTION documents_fts_trigger() RETURNS trigger AS $fts$
BEGIN
  NEW.full_text_index :=
    setweight(to_tsvector('simple', COALESCE(NEW.title,'')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.description,'')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.file_name,'')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(array_to_string(ARRAY(SELECT jsonb_array_elements_text(NEW.tags)), ' '),'')), 'C');
  RETURN NEW;
END;
$fts$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_documents_fts ON documents;
CREATE TRIGGER trg_documents_fts BEFORE INSERT OR UPDATE OF title, description, file_name, tags
  ON documents FOR EACH ROW EXECUTE FUNCTION documents_fts_trigger();

-- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_versions','document_comments','document_templates','document_template_fields'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON documents, document_versions, document_comments, document_templates, document_template_fields TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE documents_id_seq, document_versions_id_seq, document_comments_id_seq, document_templates_id_seq, document_template_fields_id_seq TO app_tenant;

COMMIT;
