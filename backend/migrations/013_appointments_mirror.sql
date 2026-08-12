-- 013: Зеркало записей стара CRM + мульти-услуги
-- Причина: appointments.legacy_ref / services.legacy_ref были INTEGER,
-- а стара CRM отдаёт GUID (text) → зеркало никогда не наполнялось,
-- reminders / repeat-visits работали по пустой таблице.

-- 1. GUID-совместимые внешние id
ALTER TABLE appointments ALTER COLUMN legacy_ref TYPE TEXT USING legacy_ref::TEXT;
ALTER TABLE services     ALTER COLUMN legacy_ref TYPE TEXT USING legacy_ref::TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_bp ON appointments(legacy_ref) WHERE legacy_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_services_bp     ON services(legacy_ref)     WHERE legacy_ref IS NOT NULL;

-- 2. Мульти-услуги: одна запись → N услуг (ТЗ M01, подмодуль 01.02)
CREATE TABLE IF NOT EXISTS appointment_services (
  id              SERIAL PRIMARY KEY,
  appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES services(id),
  master_id       INTEGER REFERENCES masters(id),
  legacy_ref    TEXT,                          -- id строки услуги в BP
  starts_at       TIMESTAMPTZ,
  duration_min    INTEGER,
  price           NUMERIC(10,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appt_services_appt ON appointment_services(appointment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_services_bp ON appointment_services(legacy_ref) WHERE legacy_ref IS NOT NULL;

-- 3. Статусы: расширение под ТЗ (state machine — этап 2)
--    booked|confirmed|in_progress|done|cancelled_client|cancelled_salon|cancelled|noshow
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS legacy_state TEXT;          -- сырой статус из BP
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;  -- момент последнего синка

-- 4. BP GUID клиента на записи (для backfill клиентов BP→local)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS legacy_client_ref TEXT;
