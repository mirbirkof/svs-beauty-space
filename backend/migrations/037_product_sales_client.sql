-- 037: Прив'язка продажів товарів до клієнта.
-- BP /sales віддає поле `client` (GUID). Зберігаємо legacy_client_ref (GUID) для бекфілу
-- та client_id (резолв до картки клієнта) для персональної історії покупок.
ALTER TABLE salon_product_sales ADD COLUMN IF NOT EXISTS legacy_client_ref TEXT;
ALTER TABLE salon_product_sales ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sps_client ON salon_product_sales(client_id);
CREATE INDEX IF NOT EXISTS idx_sps_bpclient ON salon_product_sales(legacy_client_ref);
