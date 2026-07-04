-- Дата накладної: завжди фіксується і контролюється (вимога Босса 04.07.2026)
ALTER TABLE stock_import_docs ADD COLUMN IF NOT EXISTS doc_date date;
