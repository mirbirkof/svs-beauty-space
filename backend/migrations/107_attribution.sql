-- 107: Мультиканальна атрибуція + UTM-трекінг (MKT-10).
-- Точки дотику (touchpoints) фіксуються лендінгом/віджетом запису ще до конверсії.
-- Конверсія = виконаний візит з ціною (appointments status=done). Цінність конверсії
-- розподіляється по точках дотику клієнта за обраною моделлю (first/last/linear/decay/position).
BEGIN;

CREATE TABLE IF NOT EXISTS marketing_touchpoints (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  client_id    INTEGER,                 -- NULL поки анонім; лінкуємо при ідентифікації
  anon_id      TEXT,                    -- cookie/localStorage id до реєстрації
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel      TEXT,                    -- нормалізований канал (google/meta/instagram/referral/direct/...)
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_term     TEXT,
  utm_content  TEXT,
  gclid        TEXT,                    -- Google Ads click id
  fbclid       TEXT,                    -- Meta click id
  referrer     TEXT,
  landing_path TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_tp_client ON marketing_touchpoints (tenant_id, client_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_tp_anon ON marketing_touchpoints (tenant_id, anon_id);
CREATE INDEX IF NOT EXISTS ix_tp_utm ON marketing_touchpoints (tenant_id, utm_source, utm_campaign);

ALTER TABLE marketing_touchpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_touchpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_touchpoints;
CREATE POLICY tenant_isolation ON marketing_touchpoints
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_touchpoints TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE marketing_touchpoints_id_seq TO app_tenant;

COMMIT;
