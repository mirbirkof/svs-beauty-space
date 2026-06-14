-- 040: MKT-04 Сегментация клиентов.
-- Динамические сегменты (правила → SQL) и статические (ручные списки).

CREATE TABLE IF NOT EXISTS segments (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID,
  name         TEXT NOT NULL,
  description  TEXT,
  type         TEXT NOT NULL DEFAULT 'dynamic',   -- dynamic|static|preset
  preset_key   TEXT,                              -- для type=preset (new/active/sleeping/lost/vip/birthday/...)
  rules        JSONB DEFAULT '{}'::jsonb,          -- {op:'AND'|'OR', conditions:[{field,operator,value}]}
  member_count INTEGER,                            -- кэш последнего пересчёта
  recalc_at    TIMESTAMPTZ,
  created_by   INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_segments_type ON segments(type);

-- Члены статических сегментов (ручные списки)
CREATE TABLE IF NOT EXISTS segment_members (
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (segment_id, client_id)
);
