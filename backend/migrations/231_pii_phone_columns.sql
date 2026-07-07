-- 231: колонки для шифрования телефона клиента (GDPR, envelope + blind index).
-- БЕЗОПАСНО: колонки nullable, НЕ используются пока не задан PII_KEY и не сделан бэкфилл.
-- Старый clients.phone работает как работал — ничего не ломается. Это только фундамент.
-- Этапы: (1) эти колонки [сейчас] → (2) PII_KEY в env → (3) двойная запись+бэкфилл →
-- (4) переключить поиск на phone_bidx → (5) убрать plaintext phone (после верификации).

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS phone_enc  text,   -- AES-256-GCM шифротекст (base64) для показа
  ADD COLUMN IF NOT EXISTS phone_bidx text;   -- HMAC-SHA256 отпечаток для поиска/дедупа

-- индекс для поиска и дедупа по отпечатку (в паре с tenant_id — изоляция сохраняется)
CREATE INDEX IF NOT EXISTS idx_clients_phone_bidx ON public.clients(tenant_id, phone_bidx);

COMMENT ON COLUMN public.clients.phone_enc  IS 'Зашифрованный телефон (AES-256-GCM), расшифровка ключом PII_KEY';
COMMENT ON COLUMN public.clients.phone_bidx IS 'Слепой индекс телефона (HMAC) для поиска без расшифровки';
