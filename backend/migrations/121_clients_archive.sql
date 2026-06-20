-- 121: штатна архівація клієнтів (soft-delete).
-- Додає deleted_at: NULL = активний, час = в архіві (прихований зі списків, дані й зв'язки збережені).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_clients_deleted_at ON clients (deleted_at) WHERE deleted_at IS NULL;
