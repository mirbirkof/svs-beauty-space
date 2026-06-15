-- COM-10 — Модерация отзывов (Reviews Moderation)
-- Отдельный слой модерации поверх существующего reviews.status (не ломаем reputation-модуль).
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation    TEXT NOT NULL DEFAULT 'approved'; -- pending|approved|rejected|spam
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderated_at  TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderated_by  BIGINT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation_note TEXT;

CREATE INDEX IF NOT EXISTS idx_reviews_moderation ON reviews (tenant_id, moderation, created_at DESC);

-- Существующие отзывы считаем одобренными (они уже опубликованы).
UPDATE reviews SET moderation='approved' WHERE moderation IS NULL;
