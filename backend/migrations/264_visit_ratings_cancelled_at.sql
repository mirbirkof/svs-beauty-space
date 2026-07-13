-- 264: (1) оцінка візиту КЛІЄНТОМ (Босс 13.07: «клієнт оцінює майстра або салон,
-- зірочки») — зворотний напрям до client_ratings (263, там салон оцінює клієнта).
-- Бот після виконаного візиту питає оцінку: зірки майстру, потім салону.
-- (2) appointments.cancelled_at — точний час скасування для прогнозу ризику
-- («клієнт завжди скасовує вранці»): раніше факт був, час губився в updated_at.
BEGIN;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS visit_ratings (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id(),
  appointment_id INTEGER NOT NULL,
  client_id      INTEGER,
  master_id      INTEGER,
  master_stars   SMALLINT CHECK (master_stars BETWEEN 1 AND 5),
  salon_stars    SMALLINT CHECK (salon_stars BETWEEN 1 AND 5),
  comment        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- одна оцінка на візит
CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_ratings_appt
  ON visit_ratings (tenant_id, appointment_id);
CREATE INDEX IF NOT EXISTS ix_visit_ratings_master
  ON visit_ratings (tenant_id, master_id);

ALTER TABLE visit_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_ratings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON visit_ratings;
CREATE POLICY tenant_isolation ON visit_ratings
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
