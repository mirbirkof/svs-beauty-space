-- 175: SLS-09 Subscriptions v2 — дотягування до спеки.
-- Доповнює існуючу базу (057_subscriptions.sql): trial-період, ціновий варіант
-- помісячної оплати, branch-обмеження, апгрейд/даунгрейд, recurring-платежі,
-- grace-period, перенесення невикористаних візитів, ручна корекція остатку з аудитом,
-- облік notify-нагадувань про закінчення.
-- Тільки НОВЕ, все IF NOT EXISTS. Integer SERIAL, single-salon (без RLS) — як 057/160/172.
-- НЕ змінює існуючі дані; нові колонки nullable / з дефолтами.
BEGIN;

-- ── 175.1 Доповнення тарифних планів ─────────────────────────────────────────
-- Trial-період, помісячна ціна, обмеження по філіях, перенесення (carry-over вже є у 057).
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_monthly  NUMERIC(10,2);          -- ціна за помісячної оплати
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_price    NUMERIC(10,2);          -- ціна trial-періоду (напр. 1 грн)
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days     INTEGER;                -- тривалість trial
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS branch_ids     INTEGER[] DEFAULT '{}'; -- обмеження по філіях (порожньо = всі)
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS branch_id      INTEGER;                -- осн. філія плану (NULL = всі)
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS renew_grace_days INTEGER DEFAULT 3;    -- grace-period після невдалої оплати

-- ── 175.2 Доповнення абонементів ─────────────────────────────────────────────
-- branch, метод оплати, trial/renewal, перенесені візити, лічильник невдалих оплат.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS branch_id          INTEGER;                 -- філія продажу
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method     VARCHAR(20);             -- cash | card | online
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_trial           BOOLEAN DEFAULT false;   -- активний trial-період
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at      DATE;                    -- кінець trial
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS carried_over        INTEGER DEFAULT 0;      -- перенесено візитів з мин. періоду
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewed_from_id    INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL; -- попередній абонемент при продовженні
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS upgraded_to_id     INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL;  -- новий абонемент при апгрейді
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS failed_payments    INTEGER DEFAULT 0;       -- лічильник невдалих автосписань
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until        DATE;                    -- кінець grace-period
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_notified_at TIMESTAMPTZ;            -- коли надіслано нагадування про продовження
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expiry_notified_at  TIMESTAMPTZ;            -- коли надіслано нагадування про закінчення

CREATE INDEX IF NOT EXISTS idx_sub_branch  ON subscriptions(branch_id);
CREATE INDEX IF NOT EXISTS idx_sub_renew   ON subscriptions(auto_renew, expires_at);

-- ── 175.3 Платежі по абонементах (recurring billing) ─────────────────────────
-- Облік періодичних оплат: продаж, помісячні списання, повернення.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id              SERIAL        PRIMARY KEY,
  subscription_id INTEGER       NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount          NUMERIC(10,2) NOT NULL,
  period_start    DATE,
  period_end      DATE,
  status          VARCHAR(20)   NOT NULL DEFAULT 'paid',   -- paid | pending | failed | refunded
  payment_method  VARCHAR(20),                             -- card | cash | online
  cashbox_op_id   INTEGER,                                 -- звʼязок з cash_operations
  attempt         INTEGER       NOT NULL DEFAULT 1,
  next_retry_at   TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subpay_sub    ON subscription_payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subpay_status ON subscription_payments(status);

-- ── 175.4 Журнал ручних корекцій остатку (09.03, з аудитом) ──────────────────
CREATE TABLE IF NOT EXISTS subscription_adjustments (
  id              SERIAL        PRIMARY KEY,
  subscription_id INTEGER       NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  field           VARCHAR(20)   NOT NULL,                  -- visits_remaining | minutes_remaining | expires_at
  old_value       TEXT,
  new_value       TEXT,
  delta           INTEGER,                                 -- для числових полів
  reason          TEXT,
  performed_by    TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subadj_sub ON subscription_adjustments(subscription_id);

COMMIT;
