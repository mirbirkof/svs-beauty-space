-- INT-09 Accounting / INT-10 Banking — реестр финансовых интеграций + данные.

-- Провайдеры (monobank, privatbank, checkbox, 1c, diia ...).
CREATE TABLE IF NOT EXISTS fin_providers (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  provider    TEXT NOT NULL,             -- monobank|privatbank|checkbox|onec|diia
  kind        TEXT NOT NULL,             -- banking|accounting|fiscal
  enabled     BOOLEAN NOT NULL DEFAULT false,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- Банковские транзакции (импорт из выписки/API банка) — INT-10.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  provider      TEXT,
  external_id   TEXT,
  op_date       DATE NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'UAH',
  direction     TEXT NOT NULL,           -- in|out
  description   TEXT,
  counterparty  TEXT,
  matched_cash_op_id BIGINT,             -- сверка с cash_operations
  reconciled    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx ON bank_transactions (tenant_id, provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_transactions (tenant_id, op_date DESC);

-- Фискальные чеки (Checkbox/ПРРО) — INT-09.
CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  provider      TEXT NOT NULL DEFAULT 'checkbox',
  receipt_number TEXT,
  fiscal_number TEXT,
  amount        NUMERIC(12,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created',  -- created|sent|done|error
  cash_operation_id BIGINT,
  order_id      BIGINT,
  payload       JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fiscal_tenant ON fiscal_receipts (tenant_id, created_at DESC);
