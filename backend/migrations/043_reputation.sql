-- ═══════════════════════════════════════════════════════
-- MKT-06 — Reputation Management (внутренний контур)
-- Расширяет reviews, журнал запросов отзыва, настройки репутации.
-- Внешний поллинг Google/Meta — отдельно (нужны API-ключи).
-- ═══════════════════════════════════════════════════════

-- ── Расширение reviews: ответы, заметки, тональность, источник ──
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply          TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS replied_at     TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS replied_by     INTEGER;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS internal_note  TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment      TEXT;          -- positive|neutral|negative
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source         TEXT DEFAULT 'internal'; -- internal|google|facebook|dikidi
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS escalated_at   TIMESTAMPTZ;

-- авто-тональность по рейтингу для старых записей
UPDATE reviews SET sentiment = CASE
  WHEN rating >= 4 THEN 'positive'
  WHEN rating = 3 THEN 'neutral'
  ELSE 'negative' END
WHERE sentiment IS NULL;

CREATE INDEX IF NOT EXISTS reviews_sentiment_idx ON reviews(sentiment);
CREATE INDEX IF NOT EXISTS reviews_created_idx   ON reviews(created_at DESC);

-- ── Журнал запросов отзыва (двухступенчатая логика, лимит 1/30дн) ──
CREATE TABLE IF NOT EXISTS review_request_log (
  id             SERIAL PRIMARY KEY,
  client_id      INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_phone   TEXT,
  appointment_id INTEGER,
  channel        TEXT,                    -- telegram|sms|email
  sent_at        TIMESTAMPTZ DEFAULT NOW(),
  internal_rating INTEGER,                -- оценка 1-5 на первом шаге
  redirected_to  TEXT,                    -- google|facebook|NULL
  completed      BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rrl_client_idx ON review_request_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rrl_appt_idx   ON review_request_log(appointment_id);

-- ── Настройки репутации (один ряд на тенант) ──
CREATE TABLE IF NOT EXISTS reputation_settings (
  tenant_id          UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  google_review_url  TEXT,
  facebook_review_url TEXT,
  request_enabled    BOOLEAN DEFAULT TRUE,
  min_redirect_rating SMALLINT DEFAULT 4,   -- >= этого рейтинга → редирект на площадку
  request_cooldown_days SMALLINT DEFAULT 30,
  alert_low_rating   BOOLEAN DEFAULT TRUE,   -- слать алерт при 1-3★
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO reputation_settings (tenant_id)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid)
ON CONFLICT (tenant_id) DO NOTHING;
