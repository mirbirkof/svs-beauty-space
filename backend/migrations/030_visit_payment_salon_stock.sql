-- 030_visit_payment_salon_stock.sql
-- 1) Розширюємо appointments для повної історії візитів з BeautyPro-експорту:
--    тип оплати, оцінка візиту, кешбек, ім'я клієнта та перелік послуг текстом
--    (щоб коректно відображати навіть коли немає жорсткого ID-зв'язку).
-- 2) Таблиця salon_stock — складські матеріали салону (витратні + товар на продаж)
--    з експорту product_reminders (одиниці в г/мл/шт, собівартість і ціна за одиницю).
-- Ідемпотентно.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_method TEXT;   -- 'cash'|'card'|NULL
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS rating INTEGER;         -- оцінка візиту 1-5
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cashback NUMERIC(12,2); -- нарахований кешбек
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_name TEXT;       -- ім'я клієнта (з експорту)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS services_text TEXT;     -- повний перелік послуг/товарів
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS import_batch TEXT;      -- мітка пакету імпорту

CREATE INDEX IF NOT EXISTS idx_appt_payment_method ON appointments(payment_method);

CREATE TABLE IF NOT EXISTS salon_stock (
  id           SERIAL PRIMARY KEY,
  sku          TEXT,
  name         TEXT NOT NULL,
  category     TEXT,
  kind         TEXT DEFAULT 'consumable',   -- 'consumable' | 'retail'
  unit         TEXT,                         -- 'г' | 'мл' | 'шт'
  qty          NUMERIC(14,3) DEFAULT 0,      -- залишок в одиницях
  cost_per_unit  NUMERIC(12,4),              -- собівартість за одиницю
  price_per_unit NUMERIC(12,4),              -- ціна за одиницю
  total_cost     NUMERIC(14,2),              -- сумарна собівартість залишку
  total_price    NUMERIC(14,2),              -- сумарна ціна залишку
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
);
CREATE INDEX IF NOT EXISTS idx_salon_stock_cat ON salon_stock(category);
CREATE INDEX IF NOT EXISTS idx_salon_stock_kind ON salon_stock(kind);
