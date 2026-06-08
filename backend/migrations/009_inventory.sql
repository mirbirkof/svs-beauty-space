-- ═══════════════════════════════════════════════════════
-- 009_inventory.sql — Инвентаризация: акты пересчёта, расхождения
-- ═══════════════════════════════════════════════════════

-- Акт инвентаризации (шапка)
CREATE TABLE IF NOT EXISTS inventory_audits (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_progress','completed','cancelled')),
  started_by    INTEGER,                  -- user_id
  completed_by  INTEGER,
  scope         TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full','category','brand','spot')),
  scope_filter  JSONB,                    -- {category_id:5} или {brand_id:2}
  total_items   INTEGER NOT NULL DEFAULT 0,
  total_diff    NUMERIC(12,2) NOT NULL DEFAULT 0,  -- сумма стоимости расхождений
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_audits_status ON inventory_audits(status);
CREATE INDEX IF NOT EXISTS idx_inv_audits_started ON inventory_audits(started_at DESC);

-- Позиции акта (по каждому variant: учёт vs факт)
CREATE TABLE IF NOT EXISTS inventory_audit_items (
  id             SERIAL PRIMARY KEY,
  audit_id       INTEGER NOT NULL REFERENCES inventory_audits(id) ON DELETE CASCADE,
  variant_id     INTEGER NOT NULL,
  product_name   TEXT,                    -- denormalized snapshot
  sku            TEXT,
  expected_qty   INTEGER NOT NULL,        -- по учёту
  actual_qty     INTEGER,                 -- фактически найдено (NULL пока не пересчитали)
  diff_qty       INTEGER GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  cost_per_unit  NUMERIC(12,2),           -- для оценки убытка
  diff_value     NUMERIC(12,2),           -- diff_qty * cost
  reason         TEXT,                    -- 'damage','theft','miscount','expired','other'
  notes          TEXT,
  counted_at     TIMESTAMPTZ,
  counted_by     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_items_audit ON inventory_audit_items(audit_id);
CREATE INDEX IF NOT EXISTS idx_inv_items_variant ON inventory_audit_items(variant_id);
