-- 060: SLS-06 Закупки (Purchasing). Цикл: потребность → заказ → согласование → приёмка на склад.
-- INTEGER-схема, интеграция с suppliers(005), products(001), stock_receipts(005).

-- Пороги для определения потребности и автозакупки
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock   NUMERIC(12,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_stock   NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id              SERIAL PRIMARY KEY,
  po_number       TEXT NOT NULL UNIQUE,           -- 'PO-2026-0001'
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
    -- draft|pending_approval|approved|rejected|ordered|in_transit|partially_received|received|closed|cancelled
  total_amount    NUMERIC(12,2) DEFAULT 0,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  expected_delivery DATE,
  actual_delivery   DATE,
  notes           TEXT,
  created_by      INTEGER,
  approved_by     INTEGER,
  approved_at     TIMESTAMPTZ,
  ordered_at      TIMESTAMPTZ,
  received_at     TIMESTAMPTZ,
  auto_generated  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status   ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id        TEXT REFERENCES products(id),
  product_name      TEXT,
  quantity_ordered  NUMERIC(12,3) NOT NULL,
  quantity_received NUMERIC(12,3) DEFAULT 0,
  unit_price        NUMERIC(10,2) NOT NULL,
  total_price       NUMERIC(12,2) NOT NULL,
  supplier_sku      TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_poi_order ON purchase_order_items(purchase_order_id);

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id                SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_by       INTEGER,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  has_discrepancy   BOOLEAN DEFAULT FALSE,
  discrepancy_notes TEXT,
  discrepancy_photos TEXT[],
  stock_receipt_id  INTEGER REFERENCES stock_receipts(id),  -- приход на склад
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id                  SERIAL PRIMARY KEY,
  purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  po_item_id          INTEGER REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  quantity_received   NUMERIC(12,3) NOT NULL,
  quantity_defective  NUMERIC(12,3) DEFAULT 0,
  quantity_wrong      NUMERIC(12,3) DEFAULT 0,  -- пересорт
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_approvals (
  id                SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  approver_id       INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  comment           TEXT,
  level             INTEGER DEFAULT 1,
  deadline          TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pa_order ON purchase_approvals(purchase_order_id);

CREATE TABLE IF NOT EXISTS auto_purchase_rules (
  id                   SERIAL PRIMARY KEY,
  product_id           TEXT UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  preferred_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  selection_strategy   TEXT DEFAULT 'preferred',  -- preferred|cheapest|best_rated
  max_auto_amount      NUMERIC(10,2),
  auto_approve         BOOLEAN DEFAULT FALSE,
  active               BOOLEAN DEFAULT TRUE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
