-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ FIN-06 (15.06) — Cash Flow (рух грошових коштів)
-- Рахунки/каси з балансами, перекази між ними, календар платежів
-- (планові/регулярні), прогноз балансу 30/60/90 днів, звіт ДДС.
-- Прагматично для 1 салону: реєстр потоків НЕ дублюємо —
-- джерело = cash_operations (продажі/зарплата/оренда вже там).
-- Звіт і прогноз рахуються поверх існуючих даних каси.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,                 -- 'Каса', 'ПриватБанк', 'Термінал'
  type              TEXT NOT NULL DEFAULT 'cash',  -- cash | bank | card_terminal | online
  bank_name         TEXT,
  account_number    TEXT,
  currency          TEXT DEFAULT 'UAH',
  current_balance   NUMERIC(12,2) DEFAULT 0,
  min_balance_alert NUMERIC(12,2),
  active            BOOLEAN DEFAULT true,
  sort_order        INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_transfers (
  id              SERIAL PRIMARY KEY,
  from_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  to_account_id   INTEGER NOT NULL REFERENCES bank_accounts(id),
  amount          NUMERIC(12,2) NOT NULL,
  description     TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_calendar (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER REFERENCES bank_accounts(id),
  type              TEXT NOT NULL DEFAULT 'outflow', -- inflow | outflow
  category          TEXT NOT NULL DEFAULT 'other',   -- salary|rent|taxes|purchasing|marketing|utilities|other
  amount            NUMERIC(12,2) NOT NULL,
  counterparty_name TEXT,
  description       TEXT,
  due_date          DATE NOT NULL,
  recurring         BOOLEAN DEFAULT false,
  recurrence_rule   JSONB,                           -- { interval:'monthly', day:1 }
  status            TEXT NOT NULL DEFAULT 'planned',  -- planned | paid | overdue | cancelled
  paid_at           TIMESTAMPTZ,
  created_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paycal_due    ON payment_calendar(due_date);
CREATE INDEX IF NOT EXISTS idx_paycal_status ON payment_calendar(status);
