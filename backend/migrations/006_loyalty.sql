-- Программа лояльности: уровни клиентов, рефералы, бонусы за день рождения
BEGIN;

-- Уровни лояльности (правила)
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,            -- Bronze, Silver, Gold, Platinum
  min_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonus_percent NUMERIC(5,2) NOT NULL DEFAULT 3,
  perks TEXT,
  color TEXT DEFAULT '#cd7f32',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Начальные уровни
INSERT INTO loyalty_tiers (name, min_spent, bonus_percent, perks, color) VALUES
  ('Bronze',   0,     3, 'Базовый 3% бонусов',                              '#cd7f32'),
  ('Silver',   5000,  5, 'Бонусов 5% + приоритет записи',                   '#c0c0c0'),
  ('Gold',     15000, 7, 'Бонусов 7% + день рождения подарок + персональный мастер', '#ffd700'),
  ('Platinum', 40000, 10, 'Бонусов 10% + всё что выше + закрытые акции',    '#e5e4e2')
ON CONFLICT (name) DO NOTHING;

-- Реферальная программа
CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_phone TEXT NOT NULL,          -- кто пригласил
  invited_phone TEXT NOT NULL UNIQUE,    -- кого пригласили (уникум — нельзя пригласить дважды)
  bonus_amount NUMERIC(10,2) DEFAULT 100, -- бонус приглашающему после первого визита/покупки
  bonus_credited BOOLEAN DEFAULT FALSE,
  invited_first_purchase_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_phone);
CREATE INDEX IF NOT EXISTS idx_referrals_invited ON referrals (invited_phone);

-- Бонусы ко дню рождения (история начислений)
CREATE TABLE IF NOT EXISTS birthday_bonuses (
  id SERIAL PRIMARY KEY,
  client_phone TEXT NOT NULL,
  bonus_amount NUMERIC(10,2) NOT NULL,
  year INT NOT NULL,
  credited_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_phone, year)
);
CREATE INDEX IF NOT EXISTS idx_bday_phone ON birthday_bonuses (client_phone);

-- Денормализованный кэш уровня клиента
CREATE TABLE IF NOT EXISTS client_loyalty (
  client_phone TEXT PRIMARY KEY,
  total_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
  tier_name TEXT NOT NULL DEFAULT 'Bronze',
  birthday DATE,
  invited_by TEXT,                       -- referrer_phone (если был)
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMIT;
