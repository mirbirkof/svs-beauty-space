-- 178: INF-03 Search Engine v2 — добиваем модуль до спеки.
-- Существующее (routes/search.js + 085_search_permissions.sql + 143_search_indexes.sql:
-- trgm-индексы, право search.read) НЕ трогаем. Внешний движок (Meilisearch/Elastic)
-- по спеке = опционален: здесь реализован реестр индексов поверх PostgreSQL FTS,
-- а сам поиск идёт по живым данным CRM (graceful — без внешнего сервиса).
--
-- Добавляем недостающие сущности спеки (раздел 4):
--   search_indexes    — реестр индексируемых сущностей (маппинг полей, настройки, метрики);
--   search_synonyms   — словари синонимов (двунаправленные/однонаправленные, мультиязычные);
--   search_analytics  — лог поисковых запросов (результаты, клики, CTR, zero-results, время).
--
-- Стиль — как 068/177: BIGSERIAL PK, tenant_id UUID DEFAULT current_tenant_id()
-- REFERENCES tenants(id), RLS FORCE + policy tenant_isolation, GRANT app_tenant.
-- Всё через IF NOT EXISTS — миграция идемпотентна, существующие данные не меняет.
BEGIN;

-- ── 178.1 Реестр поисковых индексов ──────────────────────────────────────────
-- Одна строка = один индексируемый тип сущности (clients/services/...). Маппинг полей
-- (searchable/filterable/sortable) и настройки (stop_words/ranking_rules) — JSONB.
-- documents_count / index_size_mb / last_indexed_at обновляет роут при reindex (наживо).
CREATE TABLE IF NOT EXISTS search_indexes (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  index_name      VARCHAR(64)  NOT NULL,                       -- clients, services, products...
  entity_type     VARCHAR(64)  NOT NULL,                       -- CRM::Client, SAL::Service...
  field_mapping   JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- {searchable:[],filterable:[],sortable:[]}
  settings        JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- {stop_words:[],ranking_rules:[]}
  documents_count INTEGER      NOT NULL DEFAULT 0,
  index_size_mb   NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_indexed_at TIMESTAMPTZ,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',      -- active|reindexing|error
  is_system       BOOLEAN      NOT NULL DEFAULT FALSE,         -- предзаведённые дефолтные индексы
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, index_name)
);
CREATE INDEX IF NOT EXISTS idx_search_indexes_tenant ON search_indexes (tenant_id);

-- ── 178.2 Словари синонимов ──────────────────────────────────────────────────
-- words[] — группа синонимов. direction both: все слова взаимозаменяемы;
-- one-way: первое слово → остальные. Подставляются в запрос перед FTS (OR-расширение).
CREATE TABLE IF NOT EXISTS search_synonyms (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  index_id        BIGINT       REFERENCES search_indexes(id) ON DELETE CASCADE,  -- NULL = глобально для всех индексов
  synonym_group   VARCHAR(128) NOT NULL,                       -- ключ группы
  words           TEXT[]       NOT NULL,                       -- массив слов-синонимов
  direction       VARCHAR(8)   NOT NULL DEFAULT 'both',        -- both|one-way
  language        VARCHAR(4)   NOT NULL DEFAULT 'uk',          -- uk|ru|en
  is_system       BOOLEAN      NOT NULL DEFAULT FALSE,         -- предзагруженные beauty-словари
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, index_id, synonym_group)
);
CREATE INDEX IF NOT EXISTS idx_synonyms_tenant_index ON search_synonyms (tenant_id, index_id);
CREATE INDEX IF NOT EXISTS idx_synonyms_words ON search_synonyms USING gin (words);

-- ── 178.3 Аналитика поисковых запросов ───────────────────────────────────────
-- Лог каждого запроса (наживо пишет роут): результаты, время, фильтры. Клик
-- регистрируется отдельным эндпоинтом (PATCH .../click) → clicked_result_id/position.
CREATE TABLE IF NOT EXISTS search_analytics (
  id                BIGSERIAL    PRIMARY KEY,
  tenant_id         UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  user_id           BIGINT,                                    -- NULL для анонимных
  query_text        VARCHAR(256) NOT NULL,
  query_normalized  VARCHAR(256) NOT NULL,                     -- lowercase, trimmed
  index_name        VARCHAR(64)  NOT NULL DEFAULT 'all',
  results_count     INTEGER      NOT NULL DEFAULT 0,
  clicked_result_id VARCHAR(64),                               -- ID выбранной сущности (id может быть TEXT — products)
  clicked_position  INTEGER,                                   -- позиция в выдаче (1-based)
  response_time_ms  INTEGER      NOT NULL DEFAULT 0,
  filters_used      JSONB,                                     -- применённые фасеты
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_tenant_date ON search_analytics (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_query ON search_analytics (query_normalized);
CREATE INDEX IF NOT EXISTS idx_analytics_zero_results ON search_analytics (tenant_id, results_count) WHERE results_count = 0;

-- ── 178.4 Доп. trgm-индекс для поиска по записям (appointments) ───────────────
-- search.js ищет записи по notes/клиенту; покрываем notes под ILIKE '%...%'.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_appointments_notes_trgm
  ON appointments USING gin (coalesce(notes,'') gin_trgm_ops);

-- ── 178.5 RLS + GRANT (как в 068/177) ────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_indexes','search_synonyms','search_analytics'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON search_indexes, search_synonyms, search_analytics TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE search_indexes_id_seq, search_synonyms_id_seq, search_analytics_id_seq TO app_tenant;

-- ── 178.6 Право search.read для аналитики/управления (дополняет 085) ──────────
-- 085 уже выдал search.read; гарантируем его наличие у owner-уровневых ролей идемпотентно.
UPDATE roles SET permissions = permissions || '["search.read"]'::jsonb
  WHERE code IN ('admin','manager','reception','administrator','owner')
    AND NOT (permissions @> '["search.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

-- ── 178.7 Сид реестра дефолтных индексов (per-tenant, для существующих салонов) ─
-- Один индекс на каждую индексируемую сущность с маппингом полей. is_system=true.
-- Сид идёт под каждый существующий tenant; для новых салонов индексы создаёт
-- bootstrap/роут. tenant_id берём явно из tenants, чтобы обойти RLS на INSERT…SELECT.
INSERT INTO search_indexes (tenant_id, index_name, entity_type, field_mapping, settings, is_system)
SELECT t.id, d.index_name, d.entity_type, d.field_mapping::jsonb, '{"ranking_rules":["exact","prefix","similarity"]}'::jsonb, TRUE
FROM tenants t
CROSS JOIN (VALUES
  ('clients',      'CRM::Client',       '{"searchable":["name","phone","email","notes","tags"],"filterable":["source","tags"],"sortable":["last_visit_at","total_spent"]}'),
  ('services',     'SAL::Service',      '{"searchable":["name","description","category"],"filterable":["category","active"],"sortable":["price","duration_min"]}'),
  ('masters',      'CRM::Master',       '{"searchable":["name","specialty","bio"],"filterable":["specialty","active"],"sortable":["name"]}'),
  ('products',     'SLS::Product',      '{"searchable":["name","description"],"filterable":["category_id","brand_id","active"],"sortable":["name"]}'),
  ('appointments', 'CRM::Appointment',  '{"searchable":["notes"],"filterable":["status","master_id","service_id"],"sortable":["starts_at"]}'),
  ('orders',       'SLS::Order',        '{"searchable":["notes"],"filterable":["status","payment_method"],"sortable":["created_at","total"]}')
) AS d(index_name, entity_type, field_mapping)
ON CONFLICT (tenant_id, index_name) DO NOTHING;

-- ── 178.8 Сид системных beauty-словарей синонимов (глобальные, index_id NULL) ──
-- Предзагруженный набор терминов индустрии красоты (uk/ru) — спека п.3.4.
INSERT INTO search_synonyms (tenant_id, index_id, synonym_group, words, direction, language, is_system)
SELECT t.id, NULL, s.grp, s.words::text[], 'both', s.lang, TRUE
FROM tenants t
CROSS JOIN (VALUES
  ('manicure',     ARRAY['маникюр','манікюр','нігті','ногти','nails'],        'uk'),
  ('pedicure',     ARRAY['педикюр','педікюр','стопи','ноги','pedicure'],      'uk'),
  ('haircut',      ARRAY['стрижка','подстрижка','підстригання','haircut'],    'uk'),
  ('coloring',     ARRAY['окрашивание','фарбування','покраска','coloring','color'], 'uk'),
  ('hair',         ARRAY['волосся','волосы','коса','hair'],                   'uk'),
  ('eyebrows',     ARRAY['брови','брова','eyebrows','brows'],                 'uk'),
  ('eyelashes',    ARRAY['вії','ресницы','ламінування вій','lashes'],         'uk'),
  ('makeup',       ARRAY['макіяж','макияж','мейкап','makeup'],                'uk'),
  ('cosmetology',  ARRAY['косметологія','косметология','чистка обличчя','cosmetology'], 'uk'),
  ('depilation',   ARRAY['депіляція','депиляция','воск','шугаринг','epilation'], 'uk'),
  ('massage',      ARRAY['масаж','массаж','massage'],                         'uk'),
  ('master',       ARRAY['майстер','мастер','спеціаліст','специалист','master'], 'uk')
) AS s(grp, words, lang)
ON CONFLICT (tenant_id, index_id, synonym_group) DO NOTHING;

COMMIT;
