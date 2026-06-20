-- 125: позначка «внутрішній» тенант (оператор / тестовий салон).
-- Внутрішні тенанти НЕ рахуються як платні клієнти у SaaS-метриках (MRR/ARR/ARPU/воронка).
-- Дохід рахується лише з реальних оплат (payments_saas succeeded), а власний салон оператора
-- та тестові акаунти виключаються з виручки навіть якщо їх ліцензія active.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE;

-- Власний control-plane тенант оператора — не платний клієнт.
UPDATE tenants SET is_internal = TRUE WHERE id = '00000000-0000-0000-0000-000000000001';

-- Очевидні тестові салони (створені QA) теж не клієнти.
UPDATE tenants SET is_internal = TRUE WHERE name ILIKE 'Test %' OR name ILIKE '%QA%' OR name ILIKE '%Isolation%';
