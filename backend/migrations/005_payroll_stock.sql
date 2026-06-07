-- Payroll (зарплата мастеров) + Stock ops (поставки, списания материалов)

CREATE TABLE IF NOT EXISTS payroll_schemes (
  id            SERIAL PRIMARY KEY,
  master_id     TEXT NOT NULL,                 -- BeautyPro employee guid
  master_name   TEXT,
  scheme_type   TEXT NOT NULL,                 -- percent|fixed|hybrid
  percent       NUMERIC(5,2),                  -- 0..100
  fixed_per_day NUMERIC(10,2),                 -- ставка за смену
  fixed_per_month NUMERIC(10,2),               -- оклад
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payroll_schemes_master_idx ON payroll_schemes(master_id);

CREATE TABLE IF NOT EXISTS payroll_records (
  id            SERIAL PRIMARY KEY,
  master_id     TEXT NOT NULL,
  master_name   TEXT,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  services_count INTEGER DEFAULT 0,
  services_revenue NUMERIC(12,2) DEFAULT 0,
  percent_part  NUMERIC(12,2) DEFAULT 0,       -- % от выручки
  fixed_part    NUMERIC(12,2) DEFAULT 0,       -- ставка/оклад
  bonus         NUMERIC(12,2) DEFAULT 0,
  deduction     NUMERIC(12,2) DEFAULT 0,
  total         NUMERIC(12,2) GENERATED ALWAYS AS (percent_part + fixed_part + bonus - deduction) STORED,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|approved|paid
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payroll_records_master_idx ON payroll_records(master_id, period_start);

CREATE TABLE IF NOT EXISTS suppliers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_receipts (
  id            SERIAL PRIMARY KEY,
  supplier_id   INTEGER REFERENCES suppliers(id),
  invoice_no    TEXT,
  received_at   TIMESTAMPTZ DEFAULT NOW(),
  total_cost    NUMERIC(12,2) DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'received', -- received|cancelled
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_receipt_items (
  id            SERIAL PRIMARY KEY,
  receipt_id    INTEGER NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id),
  product_name  TEXT,
  qty           NUMERIC(10,3) NOT NULL,
  unit_cost     NUMERIC(10,2) NOT NULL,
  total_cost    NUMERIC(12,2) GENERATED ALWAYS AS (qty * unit_cost) STORED
);
CREATE INDEX IF NOT EXISTS stock_receipt_items_receipt_idx ON stock_receipt_items(receipt_id);

-- расходы материалов мастером во время записи
CREATE TABLE IF NOT EXISTS material_consumption (
  id            SERIAL PRIMARY KEY,
  appointment_id TEXT,                         -- BP appointment guid
  master_id     TEXT,
  product_id    TEXT REFERENCES products(id),
  product_name  TEXT,
  qty           NUMERIC(10,3) NOT NULL,
  unit_cost     NUMERIC(10,2),
  total_cost    NUMERIC(12,2) GENERATED ALWAYS AS (qty * COALESCE(unit_cost, 0)) STORED,
  consumed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS material_consumption_app_idx ON material_consumption(appointment_id);
CREATE INDEX IF NOT EXISTS material_consumption_master_idx ON material_consumption(master_id);
