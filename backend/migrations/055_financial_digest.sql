-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ FIN-04 (15.06) — Фінансовий центр: налаштування щоденної зведення
-- Дашборд консолідує дані з існуючих модулів (каса, P&L) — окремі таблиці
-- снапшотів не потрібні для одного салону (рахуємо на льоту з cash_operations).
-- Тут лише налаштування Telegram-зведення дня (digest), single-tenant.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS financial_digest_settings (
  id                SERIAL PRIMARY KEY,
  channel           TEXT DEFAULT 'telegram',     -- telegram (email — на майбутнє)
  telegram_chat_id  TEXT,                        -- кому слати (за замовч. ADMIN_TG_CHAT з env)
  send_time         TEXT DEFAULT '21:00',        -- HH:MM за Київським часом
  include_expenses  BOOLEAN DEFAULT true,
  include_top       BOOLEAN DEFAULT true,        -- топ послуг/майстрів
  include_comparison BOOLEAN DEFAULT true,       -- порівняння з минулим тижнем
  skip_weekends     BOOLEAN DEFAULT false,
  is_active         BOOLEAN DEFAULT false,       -- вимкнено за замовч. — вмикає Бос
  last_sent_date    DATE,                        -- захист від дублю за день
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Єдиний рядок налаштувань (single-tenant)
INSERT INTO financial_digest_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
