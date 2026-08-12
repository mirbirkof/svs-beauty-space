-- 288_warehouses.sql — SLS-11 этап 1: измерение «склад» (салон / магазин-дистрибьютор)
-- АДДИТИВНАЯ миграция: ничего существующего не меняет и не переносит.
-- Канон салонного остатка ОСТАЁТСЯ в product_variants.stock_qty / reserved_qty —
-- весь существующий код салона (визиты, POS, инвентаризация, импорт) работает как раньше.
-- warehouse_stock используется ТОЛЬКО для несалонных складов (магазин), чтобы
-- не было двух источников правды по салону.

CREATE TABLE IF NOT EXISTS warehouses (
  id         TEXT PRIMARY KEY,             -- 'salon' | 'store'
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('salon','store')),
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO warehouses (id, name, kind) VALUES
  ('salon', 'Салон', 'salon'),
  ('store', 'Магазин (дистрибуція)', 'store')
ON CONFLICT (id) DO NOTHING;

-- Метка склада на всей истории движений. Вся существующая история = склад «Салон».
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS warehouse_id TEXT NOT NULL DEFAULT 'salon' REFERENCES warehouses(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_warehouse ON stock_movements(warehouse_id);

-- Остатки несалонных складов. Дробные количества (граммовые товары) — NUMERIC.
-- CHECK (qty >= 0): защита от списания в минус (вывод исследования этапа 0).
CREATE TABLE IF NOT EXISTS warehouse_stock (
  variant_id   INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  qty          NUMERIC(12,3) NOT NULL DEFAULT 0,
  reserved_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (variant_id, warehouse_id),
  CHECK (qty >= 0),
  CHECK (reserved_qty >= 0)
);
