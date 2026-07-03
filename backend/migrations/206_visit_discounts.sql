-- 206: скидки + сертификаты + бонусы при оплате визита.
-- Храним что применили — для отчётности и точного отката при /unpay.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_amount   NUMERIC(12,2);  -- ручна знижка (грн)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_cert_code     TEXT;           -- застосований сертифікат
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_cert_amount   NUMERIC(12,2);  -- скільки списано з сертифіката (грн)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_bonus_redeemed NUMERIC(12,2); -- скільки бонусів списано
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_bonus_money   NUMERIC(12,2);  -- грошовий еквівалент списаних бонусів
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_settled_at    TIMESTAMPTZ;    -- маркер «оплата проведена» (ідемпотентність навіть при 0 готівки)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_bonus_accrued NUMERIC(12,2);
