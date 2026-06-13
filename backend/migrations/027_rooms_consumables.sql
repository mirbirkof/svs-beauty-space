-- 027: Кабинеты/рабочие места (SAL-05) + расходники на услугу (SAL-08)

-- ── ROOMS (кабинеты / рабочие места) ──
CREATE TABLE IF NOT EXISTS rooms (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT DEFAULT '#7c5cff',   -- цвет в журнале
  capacity    INTEGER DEFAULT 1,        -- сколько мастеров/клиентов помещается
  active      BOOLEAN DEFAULT TRUE,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- запись может быть привязана к кабинету
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id);
CREATE INDEX IF NOT EXISTS idx_appointments_room ON appointments(room_id);

-- флаг что расходники по записи уже списаны (защита от двойного списания)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stock_written_off BOOLEAN DEFAULT FALSE;

-- ── SERVICE_CONSUMABLES (расходники на услугу) ──
-- сколько единиц товара/расходника уходит на одно выполнение услуги
CREATE TABLE IF NOT EXISTS service_consumables (
  id           SERIAL PRIMARY KEY,
  service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  variant_id   INTEGER NOT NULL REFERENCES product_variants(id),
  qty_per_use  NUMERIC(10,3) NOT NULL DEFAULT 1,  -- например 0.05 флакона
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_consum_service ON service_consumables(service_id);
