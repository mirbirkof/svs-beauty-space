-- GDPR: фіксація згоди власника на обробку ПД при реєстрації (блокер G1).
-- Раніше чекбокс був на фронті, але факт згоди в БД не зберігався — регулятор
-- UA/EU не приймає HTML-галочку без збереженого timestamp як доказ згоди.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS consent_given_at  timestamptz,
  ADD COLUMN IF NOT EXISTS consent_source    text,
  ADD COLUMN IF NOT EXISTS consent_ip        text,
  ADD COLUMN IF NOT EXISTS consent_version   text;
