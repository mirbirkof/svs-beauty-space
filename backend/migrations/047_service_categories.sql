-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ SAL-02 — Категории услуг (иерархический справочник)
-- Дерево неограниченной вложенности (parent_id + materialized_path),
-- мультиязык, иконки, SEO, статус, порядок сортировки.
-- Связь с услугами — по ИМЕНИ (services.category = service_categories.name),
-- как уже устроено в коде (booking/reports/cabinet keyed по тексту).
-- Существующую таблицу categories (товары магазина) НЕ трогаем.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS service_categories (
  id            SERIAL PRIMARY KEY,
  parent_id     INTEGER REFERENCES service_categories(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  name_ua       TEXT,
  name_en       TEXT,
  slug          TEXT,
  description   TEXT,
  icon          TEXT,              -- emoji или имя material-иконки
  photo_url     TEXT,
  category_type TEXT DEFAULT 'services',  -- services|products|both
  depth         INTEGER DEFAULT 0,
  materialized_path TEXT,          -- '3' | '3.7' | '3.7.12'
  sort_order    INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',    -- active|hidden
  meta_title    TEXT,
  meta_description TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  CHECK (depth >= 0 AND depth <= 10)
);
CREATE INDEX IF NOT EXISTS service_categories_parent_idx ON service_categories(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS service_categories_status_idx ON service_categories(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS service_categories_path_idx ON service_categories(materialized_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS service_categories_name_idx ON service_categories(name);

-- ── Засев корневых категорий из существующих строк services.category ──
INSERT INTO service_categories (name, slug, status, sort_order, materialized_path)
SELECT DISTINCT s.category,
       lower(regexp_replace(s.category, '[^a-zA-Z0-9а-яёіїєґ]+', '-', 'g')),
       'active', 0, NULL
  FROM services s
 WHERE s.category IS NOT NULL AND s.category <> '' AND s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM service_categories sc WHERE sc.name = s.category);

-- materialized_path для корневых = собственный id
UPDATE service_categories SET materialized_path = id::text WHERE materialized_path IS NULL;
