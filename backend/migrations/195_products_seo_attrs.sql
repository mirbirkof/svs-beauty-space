-- 195 Products: SEO-поля и атрибуты (M11 / SLS-02)
-- id товара уже человекочитаемый слаг — отдельный slug не нужен.
-- attrs: гибкие характеристики {"об'єм":"250 мл","лінія":"Eterna","тип волосся":"фарбоване"}

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS meta_title       TEXT,
  ADD COLUMN IF NOT EXISTS meta_description TEXT,
  ADD COLUMN IF NOT EXISTS attrs            JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_products_attrs ON products USING GIN (attrs);
