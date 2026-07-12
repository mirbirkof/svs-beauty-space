-- 259: партнёрская программа «приведи салон» (рост SaaS).
-- Салон-реферер приглашает другой салон по своему коду/ссылке. Когда приглашённый салон
-- оплачивает первый счёт (становится qualified), реферер получает награду (по умолчанию
-- +30 дней к своей подписке). Платформенная таблица (BEZ tenant-RLS — связь МЕЖДУ салонами).
BEGIN;

-- реф-код у каждого салона (для ссылки /signup?ref=CODE)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_code TEXT;
-- бэкфилл: короткий стабильный код из id (8 hex-символов)
UPDATE tenants SET referral_code = UPPER(SUBSTRING(REPLACE(id::text,'-','') FROM 1 FOR 8))
  WHERE referral_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_referral_code ON tenants (referral_code);

CREATE TABLE IF NOT EXISTS partner_referrals (
  id                 BIGSERIAL PRIMARY KEY,
  referrer_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referred_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  ref_code           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|qualified|rewarded|expired
  reward_type        TEXT NOT NULL DEFAULT 'days',     -- days|discount|cash
  reward_value       NUMERIC(10,2) NOT NULL DEFAULT 30,-- дней/%/грн
  referred_name      TEXT,
  qualified_at       TIMESTAMPTZ,
  rewarded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- один приглашённый салон учитывается один раз
CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_referred ON partner_referrals (referred_tenant_id)
  WHERE referred_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_partner_referrer ON partner_referrals (referrer_tenant_id, status);

-- настройка программы (глобальная, редактируется платформой)
CREATE TABLE IF NOT EXISTS partner_program_settings (
  id            INT PRIMARY KEY DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  reward_type   TEXT NOT NULL DEFAULT 'days',
  reward_value  NUMERIC(10,2) NOT NULL DEFAULT 30,   -- рефереру: +30 дней подписки
  referred_bonus_days INT NOT NULL DEFAULT 14,       -- приглашённому: +14 дней триала сверху
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);
INSERT INTO partner_program_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
