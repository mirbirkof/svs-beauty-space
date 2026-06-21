-- SAS-11 — Self-service оплата платних модулів (add-on billing).
-- Салон сам підключає платний модуль: рахунок → Mono pay-link → оплата →
-- авто-вмикання override[feature]=true + щомісячне/щорічне продовження.
-- Несплата при продовженні → модуль вимикається (override=false), без витоку.

CREATE TABLE IF NOT EXISTS tenant_addon_subscriptions (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  feature_key        TEXT NOT NULL REFERENCES saas_addons(feature_key),
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending/active/cancelled/past_due
  billing_cycle      TEXT NOT NULL DEFAULT 'monthly',   -- monthly/yearly
  price              NUMERIC(10,2) NOT NULL DEFAULT 0,
  current_period_end TIMESTAMPTZ,
  last_invoice_id    INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature_key)
);

-- швидкий пошук по рахунку (вебхук Mono веде по last_invoice_id) і по терміну (продовження)
CREATE INDEX IF NOT EXISTS idx_addon_sub_invoice ON tenant_addon_subscriptions (last_invoice_id);
CREATE INDEX IF NOT EXISTS idx_addon_sub_period  ON tenant_addon_subscriptions (status, current_period_end);
