-- 263: оцінка клієнта майстром/адміном (Босс 13.07: «щоб оцінки ставили ... і клієнтам»).
-- Салон бачить надійність клієнта: зірки 1-5 + теги (запізнення, no-show, конфліктний, топ).
-- Одна оцінка на візит (partial unique) + ручні оцінки без візиту. RLS як скрізь.
BEGIN;

CREATE TABLE IF NOT EXISTS client_ratings (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  client_id     INTEGER NOT NULL,
  appointment_id INTEGER,
  master_id     INTEGER,
  rated_by_name TEXT,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags          TEXT[] NOT NULL DEFAULT '{}',
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_client_ratings_client
  ON client_ratings (tenant_id, client_id);
-- одна оцінка на візит; ON CONFLICT з partial-індексом не можна — у роуті UPDATE-then-INSERT
CREATE UNIQUE INDEX IF NOT EXISTS ux_client_ratings_appt
  ON client_ratings (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL;

ALTER TABLE client_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ratings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_ratings;
CREATE POLICY tenant_isolation ON client_ratings
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
