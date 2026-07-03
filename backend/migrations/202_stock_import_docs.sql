-- 202: журнал імпортів складу — накладні (прихід) і прайси (номенклатура).
-- Кожен застосований документ зберігається цілком (items jsonb) для аудиту:
-- що, скільки, за якою ціною і хто заніс.

CREATE TABLE IF NOT EXISTS stock_import_docs (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','pricelist')),
  filename TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  totals JSONB NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT ON stock_import_docs TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE stock_import_docs_id_seq TO app_tenant;
