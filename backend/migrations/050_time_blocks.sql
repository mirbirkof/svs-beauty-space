-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ CRM-06 (06.05) — Блокування часу в журналі
-- Дозволяє позначити майстра недоступним на період:
-- зайнятий, перерва, відпустка, лікарняний, інше.
-- Записи (appointments) НЕ повинні падати на заблокований час.
-- Інтегрується в /api/schedule/journal (повертається масив blocks).
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS time_blocks (
  id            SERIAL PRIMARY KEY,
  master_id     INTEGER REFERENCES masters(id) ON DELETE CASCADE,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  reason        TEXT,
  block_type    TEXT DEFAULT 'busy',   -- busy|break|vacation|sick|other
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_time_blocks_master_date ON time_blocks(master_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_time_blocks_range ON time_blocks(starts_at, ends_at);
