-- 024: колонки для учёта salon-материалов (приёмка от поставщика + списание мастером)
-- routes/payroll-stock.js писал в products.stock и stock_movements(product_id, note),
-- которых не было в схеме (001 завёл сток на уровне product_variants.stock_qty, а
-- движения — с variant_id/notes). Из-за этого КАЖДАЯ приёмка товара и списание
-- материала мастером падали в ROLLBACK (500).
--
-- Доменное разделение:
--   product_variants.stock_qty — розничный остаток (то, что продаём в магазине)
--   products.stock             — остаток расходников салона (то, что мастер тратит)
-- stock_movements теперь логирует оба: variant_id (розница) ИЛИ product_id (материалы).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock NUMERIC(12,3) DEFAULT 0;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS product_id TEXT REFERENCES products(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
