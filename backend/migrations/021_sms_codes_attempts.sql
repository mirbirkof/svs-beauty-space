-- 021: защита кода входа в клиентский кабинет от перебора
-- attempts — счётчик неверных вводов; после 5 код сгорает
ALTER TABLE sms_codes ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

-- индекс для выборки активного кода по телефону
CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_active
  ON sms_codes (phone, expires_at DESC) WHERE used = false;
