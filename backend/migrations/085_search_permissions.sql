-- INF-03 Global Search: право search.read для ролей с доступом к данным.
-- owner = "*" покрывает всё автоматически. Добавляем явно админам/менеджерам/ресепшн.
UPDATE roles SET permissions = permissions || '["search.read"]'::jsonb
  WHERE code IN ('admin','manager','reception','administrator')
    AND NOT (permissions @> '["search.read"]'::jsonb)
    AND NOT (permissions @> '["*"]'::jsonb);

-- pg_trgm нужен для similarity() — на проде уже включён, ставим идемпотентно.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Триграммные индексы для быстрого нечёткого поиска (IF NOT EXISTS — идемпотентно).
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm  ON clients  USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_services_name_trgm  ON services USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_masters_name_trgm   ON masters  USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm  ON products USING gin (name gin_trgm_ops);
