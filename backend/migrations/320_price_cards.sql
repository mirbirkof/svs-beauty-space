-- price-cards-0411 (Босс 04.11): клієнт у мініапі бачить ціни ПРАЙСУ салону, а не «роботу» з CRM.
-- services.price НЕ чіпаємо (каса, зарплати). Лише ДОДАЄМО поля до таблиць міграції 319.
ALTER TABLE service_length_variants
  ADD COLUMN IF NOT EXISTS list_price          NUMERIC(12,2),   -- ціна прайсу «від X» (для клієнта)
  ADD COLUMN IF NOT EXISTS list_price_to       NUMERIC(12,2),   -- верх діапазону прайсу (550–600)
  ADD COLUMN IF NOT EXISTS list_price_top      NUMERIC(12,2),   -- ціна прайсу в топ-майстра
  ADD COLUMN IF NOT EXISTS list_price_top_to   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS work_service_top_id INTEGER;         -- послуга CRM, що йде у візит до топ-майстра
ALTER TABLE service_procedures
  ADD COLUMN IF NOT EXISTS addons         JSONB     NOT NULL DEFAULT '[]'::jsonb, -- [{key,label,price}] опції «+X ₴»
  ADD COLUMN IF NOT EXISTS top_master_ids INTEGER[] NOT NULL DEFAULT '{}',        -- топ-майстри (своя ціна/послуга)
  ADD COLUMN IF NOT EXISTS price_hint     TEXT,                                   -- «до +30% за густоти/довжини»
  ADD COLUMN IF NOT EXISTS variant_kind   TEXT      NOT NULL DEFAULT 'length';    -- 'length' (силует) | 'type' (вид)
