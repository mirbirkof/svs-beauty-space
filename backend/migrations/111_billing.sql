-- 111: SAS-03 Billing. Платформенный биллинг тенантов: подписки, счета, платежи,
-- методы оплаты, промокоды, dunning. Платформенные таблицы (как saas_plans —
-- БЕЗ per-tenant RLS): суперадмин видит всех, tenant-facing запросы фильтруют по
-- tenant_id явно. Планы по plan_code (TEXT → saas_plans.code), id SERIAL (как мигр.110).
-- Платёжный шлюз pluggable: 'manual' работает сразу (офлайн-оплата), Stripe/LiqPay/
-- Monobank активируются ключами. Суммы в UAH.
BEGIN;

-- Подписка тенанта на тариф платформы (одна активная на тенант).
CREATE TABLE IF NOT EXISTS subscriptions_saas (
  id                       SERIAL PRIMARY KEY,
  tenant_id                UUID UNIQUE NOT NULL,
  plan_code                TEXT NOT NULL,                       -- → saas_plans.code
  status                   TEXT NOT NULL DEFAULT 'trialing',    -- trialing|active|past_due|suspended|cancelled|expired
  billing_cycle            TEXT NOT NULL DEFAULT 'monthly',     -- monthly|yearly
  current_period_start     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end       TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '14 days',
  trial_ends_at            TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  payment_gateway          TEXT NOT NULL DEFAULT 'manual',      -- manual|stripe|liqpay|monobank
  gateway_subscription_id  TEXT,
  promo_code_id            INTEGER,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions_saas(status);
CREATE INDEX IF NOT EXISTS idx_sub_period_end ON subscriptions_saas(current_period_end);

-- Счета (INV-YYYY-NNNNNN).
CREATE TABLE IF NOT EXISTS invoices_saas (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL,
  subscription_id  INTEGER REFERENCES subscriptions_saas(id) ON DELETE SET NULL,
  invoice_number   TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',               -- draft|open|paid|void|uncollectible
  currency         CHAR(3) NOT NULL DEFAULT 'UAH',
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  pdf_url          TEXT,
  due_date         DATE NOT NULL DEFAULT (NOW()+INTERVAL '7 days')::date,
  paid_at          TIMESTAMPTZ,
  period_start     DATE,
  period_end       DATE,
  line_items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_tenant ON invoices_saas(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices_saas(status);

-- Платежи по счетам.
CREATE TABLE IF NOT EXISTS payments_saas (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  invoice_id         INTEGER REFERENCES invoices_saas(id) ON DELETE SET NULL,
  payment_method_id  INTEGER,
  amount             NUMERIC(12,2) NOT NULL,
  currency           CHAR(3) NOT NULL DEFAULT 'UAH',
  status             TEXT NOT NULL DEFAULT 'pending',           -- pending|processing|succeeded|failed|refunded|partially_refunded
  gateway            TEXT NOT NULL DEFAULT 'manual',
  gateway_payment_id TEXT,
  gateway_response   JSONB,
  failure_reason     TEXT,
  refunded_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pay_tenant ON payments_saas(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_gateway ON payments_saas(gateway, gateway_payment_id);

-- Сохранённые методы оплаты (токен шлюза, без хранения карты).
CREATE TABLE IF NOT EXISTS payment_methods (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  type          TEXT NOT NULL,                                  -- card|bank_account|privat24|google_pay|apple_pay
  gateway       TEXT NOT NULL,
  gateway_token TEXT NOT NULL,
  last4         CHAR(4),
  brand         TEXT,
  exp_month     SMALLINT,
  exp_year      SMALLINT,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_tenant ON payment_methods(tenant_id);

-- Промокоды (процент/фикс, лимиты, привязка к планам).
CREATE TABLE IF NOT EXISTS promo_codes_saas (
  id               SERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  description      TEXT,
  discount_type    TEXT NOT NULL DEFAULT 'percent',             -- percent|fixed_amount
  discount_value   NUMERIC(10,2) NOT NULL,
  currency         CHAR(3) DEFAULT 'UAH',
  max_uses         INTEGER,
  times_used       INTEGER NOT NULL DEFAULT 0,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until      TIMESTAMPTZ,
  applicable_plans TEXT[] NOT NULL DEFAULT '{}',                -- пусто = все планы (plan_code)
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_code ON promo_codes_saas(code) WHERE is_active = TRUE;

-- Попытки dunning (до 4) при неуспешном списании.
CREATE TABLE IF NOT EXISTS dunning_attempts (
  id                SERIAL PRIMARY KEY,
  subscription_id   INTEGER NOT NULL REFERENCES subscriptions_saas(id) ON DELETE CASCADE,
  invoice_id        INTEGER NOT NULL REFERENCES invoices_saas(id) ON DELETE CASCADE,
  attempt_number    SMALLINT NOT NULL,                          -- 1..4
  status            TEXT NOT NULL DEFAULT 'pending',            -- pending|attempted|succeeded|failed|skipped
  scheduled_at      TIMESTAMPTZ NOT NULL,
  attempted_at      TIMESTAMPTZ,
  gateway_response  JSONB,
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
  notification_type TEXT,                                       -- email|sms|both
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dun_sched ON dunning_attempts(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dun_sub ON dunning_attempts(subscription_id);

-- Платформенные таблицы — доступ роли app_tenant без RLS (кросс-тенантный суперадмин).
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions_saas, invoices_saas, payments_saas,
  payment_methods, promo_codes_saas, dunning_attempts TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE subscriptions_saas_id_seq, invoices_saas_id_seq,
  payments_saas_id_seq, payment_methods_id_seq, promo_codes_saas_id_seq, dunning_attempts_id_seq TO app_tenant;

COMMIT;
