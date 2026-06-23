-- 144: variant_id в позиции закупки (аудит 23.06, #10)
--
-- Проблема: реальный остаток для продаж/списаний хранится в
-- product_variants.stock_qty. Приёмка много-вариантного товара (46 SKU)
-- не знала какой именно вариант пополнять → приход не распределялся,
-- остатки расходились.
--
-- Фикс: позиция закупки получает целевой вариант. На приёмке:
--   • variant_id задан        → пополняем именно его (точно);
--   • не задан, 1 активный вар → пополняем единственный (как было);
--   • не задан, >1 вариантов   → предупреждение (нужно выбрать вариант в форме).
--
-- Колонка nullable — старые заказы и одно-вариантные товары не затрагиваются.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_po_items_variant
  ON purchase_order_items (variant_id) WHERE variant_id IS NOT NULL;
