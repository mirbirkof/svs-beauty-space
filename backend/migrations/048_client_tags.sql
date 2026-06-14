-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ CRM-03 (доповнення) — Теги клієнтів
-- Каталог тегів з кольорами + many-to-many привʼязка до клієнтів.
-- Колонка clients.tags (text[]) існувала, але не використовувалась —
-- переходимо на нормалізовану схему (фільтрація, лічильники, перейменування).
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS client_tag_defs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT,
  color       TEXT DEFAULT '#6b7280',   -- HEX для бейджа
  description TEXT,
  sort_order  INTEGER DEFAULT 0,
  is_system   BOOLEAN DEFAULT FALSE,    -- системні (VIP/Боржник) не видаляються
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_tag_defs_name_uq ON client_tag_defs(LOWER(name));

CREATE TABLE IF NOT EXISTS client_tags (
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES client_tag_defs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by_name TEXT,
  PRIMARY KEY (client_id, tag_id)
);
CREATE INDEX IF NOT EXISTS client_tags_tag_idx ON client_tags(tag_id);
CREATE INDEX IF NOT EXISTS client_tags_client_idx ON client_tags(client_id);

-- Засів кількох базових тегів (idempotent через LOWER(name) unique)
INSERT INTO client_tag_defs (name, color, is_system, sort_order)
SELECT v.name, v.color, TRUE, v.so
  FROM (VALUES
    ('VIP',        '#d4a017', 1),
    ('Постійний',  '#0a8f5f', 2),
    ('Новий',      '#3b82f6', 3),
    ('Боржник',    '#d9534f', 4),
    ('Проблемний', '#9333ea', 5)
  ) AS v(name, color, so)
 WHERE NOT EXISTS (SELECT 1 FROM client_tag_defs d WHERE LOWER(d.name) = LOWER(v.name));
