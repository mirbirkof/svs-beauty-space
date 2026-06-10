-- 014: Multi-Tenant Core (SAS-01) — фундамент SaaS
-- Решение Босса 10.06.2026: «Сразу саас» → tenant_id закладывается сейчас,
-- пока кодовая база 30 модулей, а не 110.
--
-- Подход: shared schema + tenant_id (per SAS-01 спецификация).
-- Этап 1 (этот файл): tenants + tenant_id NOT NULL DEFAULT <первый тенант> везде.
--   DEFAULT гарантирует: существующий код работает без изменений.
-- Этап 2 (следом): middleware-инъекция tenant context в запросы.
-- Этап 3 (до второго тенанта): RLS-политики enforcement.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Тенанты ──
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active|suspended|deleted|trial
  plan        TEXT DEFAULT 'internal',          -- internal|free|pro|enterprise (детали — SAS-04)
  limits      JSONB DEFAULT '{}'::jsonb,        -- {employees, clients, storage_mb, sms_month}
  settings    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Первый тенант — салон Босса (фиксированный UUID, на него ссылаются DEFAULT'ы)
INSERT INTO tenants (id, name, slug, status, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'SVS Beauty Space', 'svs-beauty-space', 'active', 'internal')
ON CONFLICT (id) DO NOTHING;

-- ── tenant_id во все бизнес-таблицы ──
-- NOT NULL DEFAULT = fast default (PG11+), без rewrite таблиц, без даунтайма.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('_migrations', 'tenants')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT ''00000000-0000-0000-0000-000000000001'' REFERENCES tenants(id)',
      t
    );
  END LOOP;
END $$;

-- ── Индексы по tenant_id на горячих таблицах ──
CREATE INDEX IF NOT EXISTS idx_clients_tenant        ON clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appointments_tenant   ON appointments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appt_services_tenant  ON appointment_services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant         ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant    ON order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant       ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_services_tenant       ON services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_masters_tenant        ON masters(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant       ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant          ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant      ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant ON stock_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_tenant ON loyalty_ledger(tenant_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_tenant       ON waitlist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reviews_tenant        ON reviews(tenant_id);

-- ── Уникальные ограничения, которые в SaaS должны быть per-tenant ──
-- (телефон/email клиента могут повторяться у разных салонов)
-- ВНИМАНИЕ: глобальные UNIQUE(phone)/UNIQUE(email) на clients остаются до Этапа 2,
-- т.к. их снятие требует одновременной правки upsert-логики (ON CONFLICT) в коде.
-- Зафиксировано как долг: MT-DEBT-1.
