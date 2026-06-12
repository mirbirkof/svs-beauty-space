-- 023: промокод в заказах
-- Раньше промокод только "валидировался" (/api/promo/validate), но:
--   1) скидка НЕ применялась к сумме заказа
--   2) uses НЕ инкрементировался → max_uses не работал, код можно было использовать бесконечно
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0;
