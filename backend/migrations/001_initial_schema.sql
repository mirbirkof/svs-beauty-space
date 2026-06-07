-- ═══════════════════════════════════════════════════════════
-- SVS Beauty World — Initial Schema (PostgreSQL)
-- Based on CRM research part 2 (Odoo-inspired)
-- Combines: salon CRM + e-commerce shop
-- ═══════════════════════════════════════════════════════════

-- ── CLIENTS (объединение посетителей салона и покупателей магазина) ──
CREATE TABLE IF NOT EXISTS clients (
  id            SERIAL PRIMARY KEY,
  phone         TEXT UNIQUE,
  email         TEXT UNIQUE,
  name          TEXT,
  birthday      DATE,
  avatar        TEXT,
  source        TEXT DEFAULT 'shop',         -- 'shop' | 'salon' | 'telegram' | 'beautypro'
  beautypro_id  INTEGER,                     -- зеркало для синхронизации
  telegram_id   BIGINT UNIQUE,
  loyalty_points INTEGER DEFAULT 0,
  total_spent   NUMERIC(12,2) DEFAULT 0,
  notes         TEXT,
  tags          TEXT[],                      -- ['VIP', 'аллергия', 'блондинка', ...]
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  last_visit_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_telegram ON clients(telegram_id);

-- ── MASTERS (мастера салона) ──
CREATE TABLE IF NOT EXISTS masters (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER REFERENCES clients(id), -- если мастер ещё и клиент
  phone         TEXT UNIQUE,
  name          TEXT NOT NULL,
  specialty     TEXT,                          -- 'colorist', 'cosmetolog', 'manicurist'
  bio           TEXT,
  avatar        TEXT,
  beautypro_id  INTEGER,
  schedule_json JSONB,                         -- {mon:[10,19],tue:[10,19],...}
  commission_pct NUMERIC(5,2) DEFAULT 40,      -- % с услуги
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── SERVICES (услуги салона) ──
CREATE TABLE IF NOT EXISTS services (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT,                          -- 'hair', 'nails', 'face', 'body'
  duration_min  INTEGER NOT NULL,
  price         NUMERIC(10,2) NOT NULL,
  beautypro_id  INTEGER,
  description   TEXT,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── APPOINTMENTS (записи на услуги) ──
CREATE TABLE IF NOT EXISTS appointments (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER REFERENCES clients(id),
  master_id     INTEGER REFERENCES masters(id),
  service_id    INTEGER REFERENCES services(id),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT DEFAULT 'booked',         -- 'booked'|'confirmed'|'done'|'cancelled'|'noshow'
  price         NUMERIC(10,2),                 -- зафиксированная на момент брони
  beautypro_id  INTEGER,
  source        TEXT DEFAULT 'web',            -- 'web'|'telegram'|'phone'|'walkin'
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_starts ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_master ON appointments(master_id);

-- ── BRANDS (бренды магазина: Raywell, Envie, Extremo, Invidia, ...) ──
CREATE TABLE IF NOT EXISTS brands (
  id     TEXT PRIMARY KEY,                    -- 'raywell', 'envie'
  name   TEXT NOT NULL,
  logo   TEXT,
  about  TEXT
);

-- ── CATEGORIES (категории товаров: шампуни, маски, фарби...) ──
CREATE TABLE IF NOT EXISTS categories (
  id    TEXT PRIMARY KEY,                     -- 'shampoo','mask','coloring'
  name  TEXT NOT NULL,
  icon  TEXT,
  group_name TEXT
);

-- ── PRODUCTS (товары магазина) ──
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,             -- 'rw-welcome-kit-eterna'
  name          TEXT NOT NULL,
  brand_id      TEXT REFERENCES brands(id),
  category_id   TEXT REFERENCES categories(id),
  photo         TEXT,
  description   TEXT,
  active        BOOLEAN DEFAULT TRUE,
  featured      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- ── PRODUCT VARIANTS (объёмы/размеры одного товара) ──
CREATE TABLE IF NOT EXISTS product_variants (
  id            SERIAL PRIMARY KEY,
  product_id    TEXT REFERENCES products(id) ON DELETE CASCADE,
  volume        TEXT,                         -- '200ml', '1000ml', 'стандарт'
  price         NUMERIC(10,2) NOT NULL,       -- розница
  wholesale     NUMERIC(10,2),                -- опт (для мастеров салона)
  sku           TEXT UNIQUE,
  barcode       TEXT,
  stock_qty     INTEGER DEFAULT 0,
  reserved_qty  INTEGER DEFAULT 0,
  active        BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

-- ── ORDERS (заказы магазина) ──
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  total           NUMERIC(12,2) NOT NULL,
  wholesale_total NUMERIC(12,2),
  status          TEXT DEFAULT 'pending',     -- 'pending'|'paid'|'shipped'|'delivered'|'cancelled'|'refunded'
  payment_method  TEXT,                       -- 'mono'|'cash'|'card_offline'
  delivery_type   TEXT,                       -- 'novaposhta'|'pickup'|'courier'
  delivery_json   JSONB,                      -- {name, phone, city, branch, address}
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- ── ORDER ITEMS (строки заказа) ──
CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  variant_id   INTEGER REFERENCES product_variants(id),
  product_name TEXT,                          -- snapshot
  volume       TEXT,                          -- snapshot
  qty          INTEGER NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL,
  line_total   NUMERIC(12,2) NOT NULL
);

-- ── PAYMENTS (платежи: Mono, наличные, рассрочка) ──
CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(id),
  appointment_id  INTEGER REFERENCES appointments(id),
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'UAH',
  method          TEXT NOT NULL,              -- 'mono'|'cash'|'card_offline'|'applepay'|'googlepay'
  status          TEXT DEFAULT 'pending',     -- 'pending'|'success'|'failed'|'refunded'
  external_id     TEXT,                       -- Mono invoice id
  external_data   JSONB,                      -- raw webhook
  fiscal_receipt  TEXT,                       -- ссылка на чек РРО
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  paid_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_external ON payments(external_id);

-- ── LOYALTY (история начислений/списаний баллов) ──
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER REFERENCES clients(id),
  delta       INTEGER NOT NULL,               -- + начисление, - списание
  reason      TEXT,                           -- 'order:123', 'appointment:45', 'birthday', 'referral'
  ref_id      INTEGER,
  ref_type    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUTH (сессии и SMS-коды) ──
CREATE TABLE IF NOT EXISTS sms_codes (
  id         SERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_codes(phone);

CREATE TABLE IF NOT EXISTS sessions (
  id         SERIAL PRIMARY KEY,
  client_id  INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- ── STOCK MOVEMENTS (движения склада) ──
CREATE TABLE IF NOT EXISTS stock_movements (
  id            SERIAL PRIMARY KEY,
  variant_id    INTEGER REFERENCES product_variants(id),
  delta         INTEGER NOT NULL,             -- + приход, - расход
  reason        TEXT,                         -- 'order:123', 'arrival', 'inventory', 'damage'
  ref_id        INTEGER,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
