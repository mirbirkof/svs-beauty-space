-- 262: запоминаем какого мастера освободившийся слот предложен клиенту из очереди
-- (очередь может быть на «будь-який майстер» — при підтвердженні треба знати конкретного).
BEGIN;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offered_master_id TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offered_master_name TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offered_ends TIMESTAMPTZ;
COMMIT;
