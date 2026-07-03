-- 203: продаж матеріалів клієнту за грам (фарби).
-- products.price_per_gram — ціна ПРОДАЖУ за одиницю обліку (грам/мл) для клієнта.
-- Якщо задана, вартість використаних матеріалів (appointment_materials.qty_used × ціна)
-- автоматично додається до суми оплати візиту в касі.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_per_gram NUMERIC(10,2);
