-- DikiDi-like features: reviews, favorites, blacklist, promotions

CREATE TABLE IF NOT EXISTS reviews (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_phone  TEXT,
  master_id     TEXT,                          -- BeautyPro employee guid
  master_name   TEXT,
  service_id    TEXT,                          -- BeautyPro service guid
  service_name  TEXT,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text          TEXT,
  is_anonymous  BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'published',  -- published|hidden|pending
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_master_idx ON reviews(master_id);
CREATE INDEX IF NOT EXISTS reviews_phone_idx ON reviews(client_phone);
CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews(status);

CREATE TABLE IF NOT EXISTS favorites (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  client_phone  TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- master|service|product
  target_id     TEXT NOT NULL,
  target_name   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_phone, kind, target_id)
);
CREATE INDEX IF NOT EXISTS favorites_phone_idx ON favorites(client_phone);

CREATE TABLE IF NOT EXISTS blacklist (
  id            SERIAL PRIMARY KEY,
  client_phone  TEXT UNIQUE NOT NULL,
  reason        TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promotions (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  discount_pct  INTEGER CHECK (discount_pct BETWEEN 0 AND 100),
  discount_uah  NUMERIC(10,2),
  category      TEXT,                          -- shop|salon|combo
  service_category TEXT,                       -- BP category id (optional)
  starts_at     TIMESTAMPTZ DEFAULT NOW(),
  ends_at       TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  banner_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS promotions_active_idx ON promotions(is_active, ends_at);
CREATE INDEX IF NOT EXISTS promotions_category_idx ON promotions(category);
