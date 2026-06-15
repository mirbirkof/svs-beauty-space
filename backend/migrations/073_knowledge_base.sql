-- 073: MGT-03 Knowledge Base — внутрішня Wiki салону (регламенти, інструкції, чек-листи).
-- Прагматика під один салон: BIGSERIAL/INTEGER, без branch_id, теги→TEXT[], доступ за ролями (JSONB).
-- Повнотекстовий пошук — Postgres tsvector ('simple', мовно-нейтральний). Версіонування + облік прочитань.
BEGIN;

CREATE TABLE IF NOT EXISTS kb_categories (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  parent_id   BIGINT REFERENCES kb_categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_kb_cat_parent ON kb_categories (tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS kb_articles (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  category_id       BIGINT REFERENCES kb_categories(id) ON DELETE SET NULL,
  author_id         INTEGER,
  author_name       TEXT,
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  excerpt           TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',  -- draft|review|published|archived
  version           INTEGER NOT NULL DEFAULT 1,
  is_pinned         BOOLEAN NOT NULL DEFAULT false,
  is_mandatory      BOOLEAN NOT NULL DEFAULT false,
  access_roles      JSONB,                          -- ['admin','manager','master'] | null = всі
  tags              TEXT[] NOT NULL DEFAULT '{}',
  views_count       INTEGER NOT NULL DEFAULT 0,
  helpful_count     INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv        tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
);
CREATE INDEX IF NOT EXISTS ix_kb_art_cat    ON kb_articles (tenant_id, category_id);
CREATE INDEX IF NOT EXISTS ix_kb_art_status ON kb_articles (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_kb_art_fts    ON kb_articles USING GIN (search_tsv);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_art_slug ON kb_articles (tenant_id, slug);

CREATE TABLE IF NOT EXISTS kb_versions (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  article_id     BIGINT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  change_summary TEXT,
  author_name    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_kb_ver_art ON kb_versions (tenant_id, article_id);

CREATE TABLE IF NOT EXISTS kb_article_reads (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  article_id    BIGINT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  employee_id   INTEGER,
  employee_name TEXT,
  confirmed     BOOLEAN NOT NULL DEFAULT false,
  read_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, employee_id)
);
CREATE INDEX IF NOT EXISTS ix_kb_reads_emp ON kb_article_reads (tenant_id, employee_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_categories','kb_articles','kb_versions','kb_article_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_categories, kb_articles, kb_versions, kb_article_reads TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE kb_categories_id_seq, kb_articles_id_seq, kb_versions_id_seq, kb_article_reads_id_seq TO app_tenant;

COMMIT;
