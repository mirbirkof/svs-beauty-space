-- 289_store_module.sql — SLS-11 этап 2: приёмка поставок магазина + внутренняя продажа салону
-- Аддитивно. Салонные таблицы не меняются (кроме avg_cost в warehouse_stock — таблица магазина).

-- Средневзвешенная себестоимость остатка магазина (landed cost: закупка + доля доставки)
ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(12,4) NOT NULL DEFAULT 0;

-- Приёмка поставки от поставщика на склад магазина
CREATE TABLE IF NOT EXISTS store_receipts (
  id            SERIAL PRIMARY KEY,
  warehouse_id  TEXT NOT NULL DEFAULT 'store' REFERENCES warehouses(id),
  supplier_name TEXT,
  doc_date      DATE NOT NULL,
  goods_total   NUMERIC(12,2) NOT NULL DEFAULT 0,                        -- сумма товаров по закупке
  delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (delivery_cost >= 0), -- доставка этой поставки (решение Босса 12.08)
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_receipt_items (
  id               SERIAL PRIMARY KEY,
  receipt_id       INTEGER NOT NULL REFERENCES store_receipts(id) ON DELETE CASCADE,
  variant_id       INTEGER NOT NULL REFERENCES product_variants(id),
  qty              NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_cost        NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),  -- закупочная за упаковку
  landed_unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0                -- с долей доставки (пропорционально стоимости)
);
CREATE INDEX IF NOT EXISTS idx_store_receipt_items_receipt ON store_receipt_items(receipt_id);

-- Внутренняя продажа Магазин → Салон (одна кнопка, авто-накладная, цена = ОПТ)
CREATE TABLE IF NOT EXISTS internal_transfers (
  id             SERIAL PRIMARY KEY,
  from_warehouse TEXT NOT NULL DEFAULT 'store' REFERENCES warehouses(id),
  to_warehouse   TEXT NOT NULL DEFAULT 'salon' REFERENCES warehouses(id),
  total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,  -- по оптовым ценам (доход магазина, расход салона)
  total_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,  -- себестоимость (для маржи магазина)
  notes          TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS internal_transfer_items (
  id          SERIAL PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES internal_transfers(id) ON DELETE CASCADE,
  variant_id  INTEGER NOT NULL REFERENCES product_variants(id),
  qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- оптовая цена на момент передачи
  unit_cost   NUMERIC(12,4) NOT NULL DEFAULT 0   -- landed себестоимость на момент передачи
);
CREATE INDEX IF NOT EXISTS idx_internal_transfer_items_tr ON internal_transfer_items(transfer_id);
