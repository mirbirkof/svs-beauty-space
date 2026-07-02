-- Заметки #100/#102/#105 (02.07.2026): категории по FK, интервал повторного визита, материалы визита

-- #100: услуга → категория по FK (старое текстовое services.category остаётся для совместимости)
ALTER TABLE services ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES service_categories(id);
CREATE INDEX IF NOT EXISTS idx_services_category_id ON services(category_id);

-- #102: рекомендуемый интервал повторного визита (дни), NULL = не задан
ALTER TABLE services ADD COLUMN IF NOT EXISTS rebook_interval_days INTEGER;

-- #105: фактически использованные материалы конкретного визита
CREATE TABLE IF NOT EXISTS appointment_materials (
  id             SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  variant_id     INTEGER NOT NULL REFERENCES product_variants(id),
  qty_used       NUMERIC(10,3) NOT NULL DEFAULT 1,
  note           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (appointment_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_appt_materials_appt ON appointment_materials(appointment_id);
