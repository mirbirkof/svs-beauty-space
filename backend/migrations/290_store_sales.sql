-- 290_store_sales.sql — SLS-11 этап 3: опт-контрагенты, продажи магазина, дебиторка
-- Аддитивно. Салонные таблицы не трогаем. Контрагенты магазина — ОТДЕЛЬНО от clients салона.

-- Опт-покупатели: салоны, мастера, магазины
CREATE TABLE IF NOT EXISTS store_counterparties (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'salon' CHECK (kind IN ('salon','master','shop','other')),
  phone         TEXT,
  email         TEXT,
  tax_id        TEXT,                                    -- ЄДРПОУ / ІПН
  credit_limit  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_days  INTEGER NOT NULL DEFAULT 30 CHECK (payment_days >= 0), -- отсрочка
  is_own_salon  BOOLEAN NOT NULL DEFAULT FALSE,          -- салон Босса (для внутренних продаж)
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Продажа со склада магазина: опт (контрагенту) или розница (физлицу/онлайн)
CREATE TABLE IF NOT EXISTS store_sales (
  id              SERIAL PRIMARY KEY,
  sale_type       TEXT NOT NULL CHECK (sale_type IN ('wholesale','retail')),
  counterparty_id INTEGER REFERENCES store_counterparties(id),  -- для опта
  buyer_name      TEXT,                                          -- для розницы
  channel         TEXT NOT NULL DEFAULT 'offline' CHECK (channel IN ('offline','online')),
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,              -- landed себестоимость
  paid_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  due_date        DATE,                                          -- срок оплаты (опт с отсрочкой)
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_sales_cp ON store_sales(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_store_sales_created ON store_sales(created_at);

CREATE TABLE IF NOT EXISTS store_sale_items (
  id         SERIAL PRIMARY KEY,
  sale_id    INTEGER NOT NULL REFERENCES store_sales(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  qty        NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_cost  NUMERIC(12,4) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_store_sale_items_sale ON store_sale_items(sale_id);

-- Платежи по продажам (частичная оплата долга)
CREATE TABLE IF NOT EXISTS store_payments (
  id         SERIAL PRIMARY KEY,
  sale_id    INTEGER NOT NULL REFERENCES store_sales(id) ON DELETE CASCADE,
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method     TEXT DEFAULT 'bank',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_payments_sale ON store_payments(sale_id);

-- Салон Босса как контрагент — чтобы внутренние продажи считались в экономике магазина
INSERT INTO store_counterparties (name, kind, is_own_salon, credit_limit, payment_days)
SELECT 'Мій салон (внутрішній)', 'salon', TRUE, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM store_counterparties WHERE is_own_salon = TRUE);

-- Связь внутренней накладной с контрагентом-салоном (для единой картины продаж)
ALTER TABLE internal_transfers ADD COLUMN IF NOT EXISTS counterparty_id INTEGER REFERENCES store_counterparties(id);
