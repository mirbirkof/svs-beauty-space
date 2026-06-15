-- 063: AI-05 AI Knowledge Base (RAG) — единый источник истины для AI-модулей.
-- Индексирует CRM-данные (услуги/цены, мастера/расписание, акции, FAQ) + загруженные тексты
-- в чанки с эмбеддингами (Gemini gemini-embedding-001, 768-dim, pgvector) и полнотекстовым
-- индексом (tsvector simple + pg_trgm) для гибридного/fallback-поиска без внешних вызовов.
-- RAG: вопрос → embedding → top-K cosine (или full-text fallback) → LLM → ответ с цитатами.
BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 063.1 Документы (единица индексации: одна CRM-сущность или загруженный текст)
CREATE TABLE IF NOT EXISTS ai_kb_documents (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id     INTEGER,
  source_type   TEXT NOT NULL,            -- upload | crm_service | crm_schedule | crm_faq | crm_promo | crm_product | knowledge_base
  source_id     TEXT,                     -- ID сущности в CRM (для CRM-источников)
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,            -- SHA256 для дедупликации/детекта изменений
  file_type     TEXT,                     -- pdf | docx | txt | md | html (для upload)
  file_size_bytes INTEGER,
  language      TEXT NOT NULL DEFAULT 'uk',
  chunks_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | indexed | error | outdated
  indexed_at    TIMESTAMPTZ,
  error_message TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_kb_docs_source ON ai_kb_documents (source_type, status);
CREATE INDEX IF NOT EXISTS ix_kb_docs_hash   ON ai_kb_documents (content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_docs_source ON ai_kb_documents (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL;

-- 063.2 Чанки + эмбеддинг (один эмбеддинг на чанк → храним inline, без отдельной таблицы)
CREATE TABLE IF NOT EXISTS ai_kb_chunks (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_id  BIGINT NOT NULL REFERENCES ai_kb_documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  char_count   INTEGER NOT NULL DEFAULT 0,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {section, entity_type, entity_id, language}
  embedding    VECTOR(768),                          -- Gemini gemini-embedding-001 @768; NULL = ещё не посчитан → full-text fallback
  embed_model  TEXT,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_kb_chunks_doc  ON ai_kb_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS ix_kb_chunks_tsv  ON ai_kb_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS ix_kb_chunks_trgm ON ai_kb_chunks USING GIN (content gin_trgm_ops);
-- HNSW для косинусного поиска (vector 0.8). Частичный — только по непустым эмбеддингам.
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS ix_kb_chunks_emb ON ai_kb_chunks
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'hnsw index skipped: %', SQLERRM;
END $$;

-- 063.3 Источники синхронизации (тумблер + интервал на тип источника)
CREATE TABLE IF NOT EXISTS ai_kb_sources (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id            INTEGER,
  source_type          TEXT NOT NULL,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_sync_at         TIMESTAMPTZ,
  last_sync_status     TEXT,               -- success | partial | error
  last_sync_count      INTEGER,
  last_error           TEXT,
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_sources ON ai_kb_sources (tenant_id, COALESCE(branch_id,-1), source_type);

-- 063.4 Лог запросов (аналитика, unanswered, coverage)
CREATE TABLE IF NOT EXISTS ai_kb_query_log (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  user_id            INTEGER,
  branch_id          INTEGER,
  caller_module      TEXT NOT NULL DEFAULT 'admin',  -- receptionist | agent | employee | admin | sales
  question           TEXT NOT NULL,
  retrieved_chunk_ids BIGINT[],
  retrieved_scores   NUMERIC(5,4)[],
  answer             TEXT,
  confidence         NUMERIC(3,2),
  cached             BOOLEAN NOT NULL DEFAULT FALSE,
  response_time_ms   INTEGER,
  feedback           TEXT,                 -- good | bad | NULL
  feedback_comment   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_kb_q_caller ON ai_kb_query_log (caller_module, created_at);
CREATE INDEX IF NOT EXISTS ix_kb_q_lowconf ON ai_kb_query_log (created_at) WHERE confidence < 0.5;

-- RLS: изоляция по тенанту
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_kb_documents','ai_kb_chunks','ai_kb_sources','ai_kb_query_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_kb_documents, ai_kb_chunks, ai_kb_sources, ai_kb_query_log TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE ai_kb_documents_id_seq, ai_kb_chunks_id_seq, ai_kb_sources_id_seq, ai_kb_query_log_id_seq TO app_tenant;

COMMIT;
