-- 036: Детальні продажі салонних товарів з BeautyPro (/sales type=Product)
-- BP віддає кожну позицію окремим рядком: name + quantity + sum + майстер.
-- Тут зберігаємо позиційно для аналітики (по товару, бренду, майстру, періоду).
CREATE TABLE IF NOT EXISTS salon_product_sales (
  id            SERIAL PRIMARY KEY,
  ext_ref       TEXT UNIQUE,                 -- BP sale.id (ідемпотентність)
  sale_date     TIMESTAMPTZ NOT NULL,
  product_name  TEXT NOT NULL,
  qty           NUMERIC DEFAULT 1,
  total_price   NUMERIC DEFAULT 0,
  unit_price    NUMERIC,                      -- total/qty
  master_id     INTEGER REFERENCES masters(id) ON DELETE SET NULL,
  master_name   TEXT,
  stock_id      INTEGER REFERENCES salon_stock(id) ON DELETE SET NULL,  -- fuzzy-match до складу
  matched       BOOLEAN DEFAULT FALSE,
  source        TEXT DEFAULT 'beautypro',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sps_date ON salon_product_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sps_stock ON salon_product_sales(stock_id);
CREATE INDEX IF NOT EXISTS idx_sps_master ON salon_product_sales(master_id);
