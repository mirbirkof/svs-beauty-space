-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ SLS-08 (15.06) — Подарункові сертифікати
-- Випуск, продаж, перевірка, використання (повне/часткове), повернення,
-- анулювання, аналітика. Прагматична версія для одного салону:
-- без серій і дизайн-шаблонів (надлишково) — штучний випуск сертифіката.
-- Інтеграція з касою на рівні запису операцій робиться окремо (предоплата).
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gift_certificates (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,        -- GC-XXXX-XXXX
  type             TEXT NOT NULL DEFAULT 'nominal',  -- nominal | service
  service_id       INTEGER,                     -- для цільового сертифіката
  original_amount  NUMERIC(10,2) NOT NULL,
  remaining_amount NUMERIC(10,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
                   -- active | partially_used | fully_used | expired | cancelled
  buyer_name       TEXT,
  buyer_phone      TEXT,
  recipient_name   TEXT,
  recipient_phone  TEXT,
  valid_until      DATE NOT NULL,
  sold_by          TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gc_code    ON gift_certificates(code);
CREATE INDEX IF NOT EXISTS idx_gc_status  ON gift_certificates(status);
CREATE INDEX IF NOT EXISTS idx_gc_valid   ON gift_certificates(valid_until);

CREATE TABLE IF NOT EXISTS gift_certificate_transactions (
  id              SERIAL PRIMARY KEY,
  gc_id           INTEGER NOT NULL REFERENCES gift_certificates(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,               -- issue | usage | refund | cancellation | expiry
  amount          NUMERIC(10,2) NOT NULL,
  balance_after   NUMERIC(10,2) NOT NULL,
  appointment_id  INTEGER,
  order_id        INTEGER,
  performed_by    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gct_gc ON gift_certificate_transactions(gc_id);
