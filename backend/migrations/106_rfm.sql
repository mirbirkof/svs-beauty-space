-- 106: RFM-аналіз (MKT-04). Recency/Frequency/Monetary по клієнтах + макросегменти.
-- Recency  = днів з останнього візиту (clients.last_visit_at)
-- Frequency= к-сть виконаних записів (appointments status=done)
-- Monetary = clients.total_spent
-- Оцінки 1..5 рахуються квінтилями (NTILE) серед АКТИВНИХ клієнтів (хоч 1 done-візит).
-- Матеріалізується через POST /api/rfm/refresh; читається для heat-map і сегментів.
BEGIN;

CREATE TABLE IF NOT EXISTS rfm_scores (
  client_id     INTEGER PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  recency_days  INTEGER,
  frequency     INTEGER NOT NULL DEFAULT 0,
  monetary      NUMERIC(12,2) NOT NULL DEFAULT 0,
  r_score       SMALLINT,           -- 1..5 (5 = найсвіжіший)
  f_score       SMALLINT,           -- 1..5 (5 = найчастіший)
  m_score       SMALLINT,           -- 1..5 (5 = найбільше витрат)
  segment       TEXT,               -- champions|loyal|potential|new|promising|need_attention|at_risk|cant_lose|hibernating|lost
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_rfm_segment ON rfm_scores (tenant_id, segment);
CREATE INDEX IF NOT EXISTS ix_rfm_cell ON rfm_scores (tenant_id, r_score, f_score);

ALTER TABLE rfm_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfm_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rfm_scores;
CREATE POLICY tenant_isolation ON rfm_scores
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON rfm_scores TO app_tenant;

COMMIT;
