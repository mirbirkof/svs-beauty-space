-- ═══════════════════════════════════════════════════════════════════════
-- FIN-06 v2 — cash_flow_entries (ручні записи + звірка з банком)
-- Доповнює міграцію 059 (bank_accounts, payment_calendar).
-- Реєстр потоків = cash_operations (авто) + cash_flow_entries (ручні).
-- ═══════════════════════════════════════════════════════════════════════

-- Ручні записи руху ДС (не дублюємо cashbox — тільки те, чого там нема)
CREATE TABLE IF NOT EXISTS cash_flow_entries (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER REFERENCES bank_accounts(id),
  type              TEXT NOT NULL DEFAULT 'outflow', -- inflow | outflow
  category          TEXT NOT NULL DEFAULT 'other',
  subcategory       TEXT,
  amount            NUMERIC(12,2) NOT NULL,
  currency          TEXT DEFAULT 'UAH',
  description       TEXT,
  counterparty_name TEXT,
  counterparty_type TEXT,                           -- client|supplier|employee|landlord|tax_authority|other
  source_type       TEXT DEFAULT 'manual',          -- manual | import
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  reconciled        BOOLEAN DEFAULT false,
  bank_statement_ref TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cfe_date    ON cash_flow_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cfe_type    ON cash_flow_entries(type);
CREATE INDEX IF NOT EXISTS idx_cfe_account ON cash_flow_entries(account_id);

-- Журнал імпорту банківських виписок
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER REFERENCES bank_accounts(id),
  filename     TEXT,
  row_count    INTEGER DEFAULT 0,
  matched      INTEGER DEFAULT 0,
  unmatched    INTEGER DEFAULT 0,
  raw_preview  JSONB,                              -- перші 5 рядків
  imported_by  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
