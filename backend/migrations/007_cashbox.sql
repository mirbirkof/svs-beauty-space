-- ═══════════════════════════════════════════════════════
-- 007_cashbox.sql — Касса салона: смены, операции, Z-отчёт
-- Финансовая основа CRM. Без этого все цифры в воздухе.
-- ═══════════════════════════════════════════════════════

-- Кассовые смены (открытие/закрытие, ответственный, остаток)
CREATE TABLE IF NOT EXISTS cash_shifts (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER,                              -- филиал (FK добавим в 010)
  opened_by     INTEGER,                              -- master_id ответственного
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  opening_cash  NUMERIC(12,2) NOT NULL DEFAULT 0,     -- стартовый остаток
  closing_cash  NUMERIC(12,2),                        -- фактический пересчёт
  expected_cash NUMERIC(12,2),                        -- расчётный (open + cash_in - cash_out)
  difference    NUMERIC(12,2),                        -- closing - expected
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','reconciled')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cash_shifts_status ON cash_shifts(status);
CREATE INDEX IF NOT EXISTS idx_cash_shifts_opened ON cash_shifts(opened_at DESC);

-- Кассовые операции (приход/расход внутри смены)
CREATE TABLE IF NOT EXISTS cash_operations (
  id           SERIAL PRIMARY KEY,
  shift_id     INTEGER NOT NULL REFERENCES cash_shifts(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('in','out')),
  category     TEXT NOT NULL,
  -- in: sale_service, sale_product, prepayment, return, encashment_in, other_in
  -- out: salary, supplier, rent, utilities, refund, encashment_out, other_out
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer','mono','other')),
  ref_type     TEXT,                                  -- 'order','appointment','payroll','manual'
  ref_id       INTEGER,                               -- ссылка на источник
  master_id    INTEGER,                               -- кто пробил
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cash_ops_shift ON cash_operations(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_ops_type ON cash_operations(type, category);
CREATE INDEX IF NOT EXISTS idx_cash_ops_created ON cash_operations(created_at DESC);

-- Z-отчёт (сводка закрытой смены, неизменяемая)
CREATE TABLE IF NOT EXISTS z_reports (
  id              SERIAL PRIMARY KEY,
  shift_id        INTEGER NOT NULL UNIQUE REFERENCES cash_shifts(id),
  report_no       SERIAL,                             -- сквозной номер Z-отчёта
  branch_id       INTEGER,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  total_in        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_out       NUMERIC(12,2) NOT NULL DEFAULT 0,
  cash_in         NUMERIC(12,2) NOT NULL DEFAULT 0,   -- по способам оплаты
  cash_out        NUMERIC(12,2) NOT NULL DEFAULT 0,
  card_in         NUMERIC(12,2) NOT NULL DEFAULT 0,
  transfer_in     NUMERIC(12,2) NOT NULL DEFAULT 0,
  services_total  NUMERIC(12,2) NOT NULL DEFAULT 0,   -- по категориям
  products_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
  salary_total    NUMERIC(12,2) NOT NULL DEFAULT 0,
  supplier_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
  operations_cnt  INTEGER NOT NULL DEFAULT 0,
  opening_cash    NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_cash    NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_cash   NUMERIC(12,2) NOT NULL DEFAULT 0,
  difference      NUMERIC(12,2) NOT NULL DEFAULT 0,
  raw_breakdown   JSONB,                              -- детализация по категориям
  closed_by       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_z_reports_period ON z_reports(period_start DESC);

-- Налоги (простой реестр — для отчётности позже)
CREATE TABLE IF NOT EXISTS tax_records (
  id           SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  type         TEXT NOT NULL,                         -- 'единый','ЄСВ','ПДВ','інше'
  base_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,      -- база
  tax_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,      -- сумма налога
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue')),
  paid_at      TIMESTAMPTZ,
  paid_amount  NUMERIC(12,2),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tax_period ON tax_records(period_start DESC);
CREATE INDEX IF NOT EXISTS idx_tax_status ON tax_records(status);
