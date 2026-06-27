-- Migration 182: FIN-10 KPI Branches — branch_kpi_snapshots
-- Stores periodic snapshots of branch KPIs (week/month/quarter)
-- for historical trend analysis and plan-fact comparison.

CREATE TABLE IF NOT EXISTS branch_kpi_snapshots (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  branch_id   INTEGER NOT NULL,
  period_type VARCHAR(10)  NOT NULL, -- 'week' | 'month' | 'quarter'
  period_start DATE        NOT NULL,
  metrics     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- { revenue, visits, clients, avg_check, occupancy, cancel_rate, new_clients }
  rank        INTEGER,
  total_score DECIMAL(5,2),
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, branch_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS ix_bks_tenant_branch
  ON branch_kpi_snapshots (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS ix_bks_period
  ON branch_kpi_snapshots (tenant_id, period_type, period_start);

-- Migration registration handled by the runner (_migrations table).
