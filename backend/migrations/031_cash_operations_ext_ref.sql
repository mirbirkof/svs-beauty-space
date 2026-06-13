-- 031: внешний идентификатор операции кассы для идемпотентного импорта/синхро.
-- ext_ref хранит GUID продажи BeautyPro (sale.id). Уникальность гарантирует,
-- что повторный импорт/крон не задвоит одну и ту же продажу.
ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS ext_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_operations_ext_ref
  ON cash_operations (ext_ref) WHERE ext_ref IS NOT NULL;
