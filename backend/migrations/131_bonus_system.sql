-- FIN-01 — Bonus System (бонусний гаманець клієнта).
-- Нарахування за дії (оплата/відгук/реферал/ДН/серія візитів/привітання),
-- списання як частина оплати (ліміт % від чека), ручні коригування,
-- FIFO-сгорання за expires_at. Усе ізольовано по tenant_id (RLS + FORCE).

-- 1) Правила нарахування
CREATE TABLE IF NOT EXISTS bonus_rules (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id(),
  branch_id          INTEGER,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'percent_check', -- percent_check/fixed_action/event
  trigger_event      TEXT NOT NULL DEFAULT 'payment',       -- payment/review/referral/birthday/visit_series/welcome
  percent            NUMERIC(6,2) NOT NULL DEFAULT 0,
  fixed_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  category           TEXT NOT NULL DEFAULT 'all',           -- services/products/all
  min_check_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  visit_series_count INTEGER NOT NULL DEFAULT 0,
  loyalty_multipliers JSONB NOT NULL DEFAULT '{"bronze":1,"silver":1.5,"gold":2}',
  max_accrual        NUMERIC(10,2),
  hold_days          INTEGER NOT NULL DEFAULT 0,
  expiry_days        INTEGER,                                -- NULL = глобальна з налаштувань
  priority           INTEGER NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bonus_rules_active ON bonus_rules (tenant_id, is_active, trigger_event);

-- 2) Транзакції (лог нарахувань/списань), remaining для FIFO
CREATE TABLE IF NOT EXISTS bonus_transactions (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  client_id     INTEGER NOT NULL,
  branch_id     INTEGER,
  type          TEXT NOT NULL,            -- accrual/redemption/expired/manual_add/manual_deduct/referral/birthday/review/welcome/visit_series
  amount        NUMERIC(10,2) NOT NULL,   -- + нарахування, - списання
  balance_after NUMERIC(10,2) NOT NULL DEFAULT 0,
  remaining     NUMERIC(10,2) NOT NULL DEFAULT 0, -- скільки з цього нарахування ще доступно (для FIFO/сгорання)
  rule_id       INTEGER,
  source_type   TEXT,                     -- payment/appointment/manual/...
  source_id     INTEGER,
  description   TEXT,
  adjusted_by   INTEGER,                  -- users.id, хто зробив ручне коригування
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bonus_tx_client ON bonus_transactions (tenant_id, client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bonus_tx_fifo   ON bonus_transactions (tenant_id, client_id, expires_at) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS idx_bonus_tx_expiry ON bonus_transactions (tenant_id, expires_at) WHERE remaining > 0;

-- 3) Баланс (агрегат, оновлюється в транзакції разом з логом)
CREATE TABLE IF NOT EXISTS bonus_balances (
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id(),
  client_id         INTEGER NOT NULL,
  balance           NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_accrued     NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_redeemed    NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_expired     NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_accrual_at   TIMESTAMPTZ,
  last_redemption_at TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_id),
  CHECK (balance >= 0)
);

-- 4) Налаштування списання (одна стрічка на tenant)
CREATE TABLE IF NOT EXISTS bonus_redemption_settings (
  tenant_id          UUID PRIMARY KEY DEFAULT current_tenant_id(),
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  max_pay_percent    NUMERIC(5,2) NOT NULL DEFAULT 30,   -- макс % чека, що можна закрити бонусами
  min_redeem_amount  NUMERIC(10,2) NOT NULL DEFAULT 10,  -- мін. бонусів для списання
  exchange_rate      NUMERIC(10,4) NOT NULL DEFAULT 1,   -- 1 бонус = N грн
  hold_period_days   INTEGER NOT NULL DEFAULT 0,         -- скільки днів бонус «заморожений» після нарахування
  expiry_days        INTEGER NOT NULL DEFAULT 365,       -- через скільки днів бонус згорає
  vip_no_expiry      BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_categories JSONB NOT NULL DEFAULT '[]',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: ізоляція по tenant_id для всіх 4 таблиць
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bonus_rules','bonus_transactions','bonus_balances','bonus_redemption_settings']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
  END LOOP;
END $$;
