-- VID-01 AI Video Studio: бібліотека згенерованих відео.
-- Причина: раніше готовий ролик віддавався як blob у браузер і ніде не зберігався —
-- після оновлення сторінки відео зникало. Тепер кожен змонтований ролик
-- зберігається на диск (uploads/video/) + запис тут, і показується в галереї.

CREATE TABLE IF NOT EXISTS ai_video_library (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(160),
  storage_path TEXT        NOT NULL,            -- відносний шлях під uploads/
  aspect       VARCHAR(10),                     -- 9:16 | 1:1 | 16:9
  duration_sec INTEGER,
  clips        INTEGER,
  size_bytes   BIGINT,
  created_by   VARCHAR(120),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_video_lib_created ON ai_video_library (created_at DESC);
