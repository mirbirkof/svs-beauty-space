-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ SAL-01 — Услуги: полная карточка, вариации, цены по мастерам,
-- комплексы (составные услуги), история изменения цен.
-- Адаптировано под существующую integer-схему (services.id SERIAL).
-- Базовые поля services (name, category, duration_min, price, description,
-- active, beautypro_id) НЕ трогаем — расширяем.
-- ═══════════════════════════════════════════════════════

-- ── 01.02 Карточка услуги: расширяем services ──
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_ua        TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_en        TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS slug           TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS internal_note  TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS buffer_before  INTEGER DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS buffer_after   INTEGER DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS min_booking_interval INTEGER DEFAULT 30;
ALTER TABLE services ADD COLUMN IF NOT EXISTS max_simultaneous INTEGER DEFAULT 1;
ALTER TABLE services ADD COLUMN IF NOT EXISTS required_room_type TEXT;   -- cabinet|hall|vip|NULL(any)
ALTER TABLE services ADD COLUMN IF NOT EXISTS photo_urls     JSONB DEFAULT '[]'::jsonb;
ALTER TABLE services ADD COLUMN IF NOT EXISTS icon           TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS color          TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'active'; -- active|inactive|draft
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_new         BOOLEAN DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_hit         BOOLEAN DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_discounted  BOOLEAN DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS age_restriction INTEGER;
ALTER TABLE services ADD COLUMN IF NOT EXISTS contraindications TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS meta_title     TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS sort_order     INTEGER DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE services ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;

-- Синхронизируем status с существующим флагом active (только для старых строк)
UPDATE services SET status = CASE WHEN active THEN 'active' ELSE 'inactive' END
 WHERE status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS services_slug_uq ON services(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS services_status_idx ON services(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS services_category_idx ON services(category);

-- ── 01.03 Вариации услуги ──
CREATE TABLE IF NOT EXISTS service_variations (
  id            SERIAL PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  variation_type TEXT NOT NULL DEFAULT 'custom',   -- length|complexity|area|custom
  price         NUMERIC(10,2) NOT NULL,
  duration_min  INTEGER NOT NULL,
  description   TEXT,
  sort_order    INTEGER DEFAULT 0,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service_id, name)
);
CREATE INDEX IF NOT EXISTS service_variations_svc_idx ON service_variations(service_id, active);

-- ── 01.04 Индивидуальные цены мастеров ──
CREATE TABLE IF NOT EXISTS service_master_prices (
  id            SERIAL PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  price         NUMERIC(10,2),     -- NULL = базовая цена услуги
  duration_min  INTEGER,           -- NULL = базовая длительность
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service_id, master_id)
);
CREATE INDEX IF NOT EXISTS service_master_prices_svc_idx ON service_master_prices(service_id);
CREATE INDEX IF NOT EXISTS service_master_prices_mst_idx ON service_master_prices(master_id);

-- ── 01.05 Составные услуги (комплексы) ──
CREATE TABLE IF NOT EXISTS service_combos (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT,
  description   TEXT,
  combo_price   NUMERIC(10,2) NOT NULL,
  total_duration INTEGER NOT NULL DEFAULT 0,
  photo_url     TEXT,
  status        TEXT DEFAULT 'active',   -- active|inactive|draft
  valid_from    DATE,
  valid_until   DATE,
  max_sales     INTEGER,                 -- NULL = без лимита
  current_sales INTEGER DEFAULT 0,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_combos_slug_uq ON service_combos(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_combos_status_idx ON service_combos(status);

CREATE TABLE IF NOT EXISTS service_combo_items (
  id            SERIAL PRIMARY KEY,
  combo_id      INTEGER NOT NULL REFERENCES service_combos(id) ON DELETE CASCADE,
  service_id    INTEGER NOT NULL REFERENCES services(id),
  variation_id  INTEGER REFERENCES service_variations(id),
  execution_order INTEGER NOT NULL DEFAULT 0,
  allow_different_master BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (combo_id, service_id)
);
CREATE INDEX IF NOT EXISTS service_combo_items_combo_idx ON service_combo_items(combo_id);

-- ── 01.02 История изменения цен ──
CREATE TABLE IF NOT EXISTS service_price_history (
  id            SERIAL PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  variation_id  INTEGER REFERENCES service_variations(id) ON DELETE CASCADE,
  old_price     NUMERIC(10,2),
  new_price     NUMERIC(10,2) NOT NULL,
  changed_by    INTEGER,
  changed_by_name TEXT,
  reason        TEXT,
  changed_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS service_price_history_svc_idx ON service_price_history(service_id, changed_at);
