-- 157: CRM-04 CRM Card — агрегатор картки клієнта. Власних таблиць майже нема
-- (бере дані з clients/appointments/orders/bonus_transactions/...). Додаються лише
-- дві: нотатки оператора та предпочтения клієнта. single-salon: integer SERIAL.
BEGIN;

CREATE TABLE IF NOT EXISTS client_notes (
  id          SERIAL       PRIMARY KEY,
  client_id   INTEGER      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_name TEXT,
  note        TEXT         NOT NULL,
  pinned      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_client_notes_client ON client_notes (client_id, pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS client_preferences (
  id                    SERIAL      PRIMARY KEY,
  client_id             INTEGER     NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  preferred_master_id   INTEGER,
  backup_master_id      INTEGER,
  preferred_time        VARCHAR(10),                 -- morning|afternoon|evening
  preferred_services    INTEGER[],
  communication_channel VARCHAR(20),                 -- telegram|sms|phone|email
  language              VARCHAR(5)  DEFAULT 'uk',
  allergies             TEXT,
  contraindications     TEXT,
  notes_master          TEXT,
  tags                  TEXT[],
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON client_notes, client_preferences TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE client_notes_id_seq, client_preferences_id_seq TO app_tenant;

COMMIT;
