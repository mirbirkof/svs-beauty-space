-- 019: предоплата за онлайн-запись через Mono
-- payments ← связка с online_bookings (appointment_id остаётся для старой appointments)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_id integer REFERENCES online_bookings(id);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id) WHERE booking_id IS NOT NULL;

-- отметка предоплаты на самой записи
ALTER TABLE online_bookings ADD COLUMN IF NOT EXISTS prepaid_amount numeric;
ALTER TABLE online_bookings ADD COLUMN IF NOT EXISTS prepaid_at timestamptz;
