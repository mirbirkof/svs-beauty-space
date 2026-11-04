-- 317 (Босс 04.11, loyalty-0411): бонуси майстру 0.5% від чека клієнта за кожну умову
-- (повернення / перезапис у день візиту / оцінка ≥ порогу) — на бонусний рахунок
-- КЛІЄНТСЬКОЇ картки самого майстра. Один рядок = візит + умова (ідемпотентність).
-- Сторно (скасування/повернення оплати) — status='reversed', рядок НЕ видаляється.
-- appointments.pay_bonus_base — база кешбеку (реально сплачені гроші: каса/термінал/Mono +
-- передоплата, без бонусів/сертифіката/абонемента). Лише ADD; наявні дані не змінюються.
BEGIN;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pay_bonus_base NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS master_loyalty_rewards (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  master_id        INTEGER NOT NULL,
  master_client_id INTEGER NOT NULL,
  appointment_id   INTEGER NOT NULL,
  client_id        INTEGER,
  condition        TEXT NOT NULL CHECK (condition IN ('return','rebook','rating')),
  percent          NUMERIC(6,3) NOT NULL,
  check_amount     NUMERIC(12,2) NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,
  bonus_tx_id      INTEGER,
  status           TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued','reversed')),
  reverse_reason   TEXT,
  reversed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_loyalty_appt_cond
  ON master_loyalty_rewards (tenant_id, appointment_id, condition);
CREATE INDEX IF NOT EXISTS ix_master_loyalty_master
  ON master_loyalty_rewards (tenant_id, master_id, created_at DESC);

ALTER TABLE master_loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_loyalty_rewards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_loyalty_rewards;
CREATE POLICY tenant_isolation ON master_loyalty_rewards
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
