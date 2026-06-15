-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ SLS-09 (15.06) — Абонементи (subscriptions)
-- Тарифні плани, продаж, списання візитів/хвилин, заморозка,
-- перенесення, повернення/розірвання, аналітика.
-- Адаптовано під integer-схему (clients/services/masters = SERIAL).
-- Прагматично для 1 салону: без recurring billing з картами
-- (немає платіжного шлюзу) — оплата фіксується в касі окремо.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  type              TEXT NOT NULL DEFAULT 'visits',  -- visits | time | minutes | combo
  visits_included   INTEGER,                          -- для visits/combo
  minutes_included  INTEGER,                          -- для minutes
  duration_days     INTEGER NOT NULL DEFAULT 365,     -- строк дії
  price             NUMERIC(10,2) NOT NULL,
  service_ids       INTEGER[] DEFAULT '{}',           -- на які послуги (порожньо = будь-які)
  category_ids      INTEGER[] DEFAULT '{}',
  master_restriction TEXT DEFAULT 'any',              -- any | specific
  master_ids        INTEGER[] DEFAULT '{}',
  auto_renew        BOOLEAN DEFAULT false,
  max_freezes       INTEGER DEFAULT 2,
  max_freeze_days   INTEGER DEFAULT 14,
  carry_over_visits BOOLEAN DEFAULT false,
  max_carry_over    INTEGER DEFAULT 0,
  max_users         INTEGER DEFAULT 1,                -- сімейний: до N користувачів
  active            BOOLEAN DEFAULT true,
  sort_order        INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  SERIAL PRIMARY KEY,
  plan_id             INTEGER NOT NULL REFERENCES subscription_plans(id),
  client_id           INTEGER NOT NULL REFERENCES clients(id),
  subscription_number TEXT NOT NULL UNIQUE,           -- SUB-2026-0001
  status              TEXT NOT NULL DEFAULT 'active',  -- active | frozen | expired | cancelled
  visits_remaining    INTEGER,
  minutes_remaining   INTEGER,
  started_at          DATE NOT NULL,
  expires_at          DATE NOT NULL,
  frozen_at           TIMESTAMPTZ,
  unfreeze_at         DATE,
  freeze_count        INTEGER DEFAULT 0,
  total_frozen_days   INTEGER DEFAULT 0,
  auto_renew          BOOLEAN DEFAULT false,
  sold_by             TEXT,
  sold_at             TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_client  ON subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_sub_status  ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_sub_expires ON subscriptions(expires_at);

-- Сімейні користувачі (до max_users). primary додається автоматично при продажу.
CREATE TABLE IF NOT EXISTS subscription_users (
  id              SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  is_primary      BOOLEAN DEFAULT false,
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,
  UNIQUE (subscription_id, client_id)
);

CREATE TABLE IF NOT EXISTS subscription_usage (
  id              SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  client_id       INTEGER,                            -- хто використав (сімейний)
  appointment_id  INTEGER,
  type            TEXT NOT NULL DEFAULT 'visit',      -- visit | minutes
  quantity        INTEGER NOT NULL DEFAULT 1,
  balance_after   INTEGER NOT NULL,
  performed_by    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subuse_sub ON subscription_usage(subscription_id);

CREATE TABLE IF NOT EXISTS subscription_freezes (
  id              SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  frozen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unfrozen_at     TIMESTAMPTZ,
  reason          TEXT,
  days            INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subfreeze_sub ON subscription_freezes(subscription_id);
