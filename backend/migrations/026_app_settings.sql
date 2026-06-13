-- ═══════════════════════════════════════════════════════
-- 026_app_settings.sql — Глобальні налаштування CRM (key-value)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER
);

-- Майстри за замовчуванням НЕ бачать номери телефонів клієнтів
INSERT INTO app_settings (key, value) VALUES
  ('masters_see_phone', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
