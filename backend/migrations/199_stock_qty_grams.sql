-- 199_stock_qty_grams.sql — облік матеріалів по грамах (замітка власника #109).
-- Проблема: appointment_materials.qty_used / service_consumables.qty_per_use — NUMERIC(10,3)
-- (грами/мл пишуться коректно), але product_variants.stock_qty був INTEGER і
-- lib/consumables.js робив Math.ceil → "45 г фарби" списувало 1 цілу одиницю складу.
-- Рішення: склад і рухи складу переводимо в NUMERIC(12,3) — дробові кількості
-- зберігаються точно. integer → numeric без втрати даних (безпечний ALTER).
ALTER TABLE product_variants ALTER COLUMN stock_qty TYPE NUMERIC(12,3) USING stock_qty::numeric;
ALTER TABLE stock_movements  ALTER COLUMN delta     TYPE NUMERIC(12,3) USING delta::numeric;
