-- 016: MT-DEBT-1 — бизнес-ключи становятся per-tenant
-- 1) tenant_id DEFAULT берётся из GUC app.tenant_id (контекст запроса),
--    fallback — первый тенант. Все существующие INSERT-ы автоматически
--    пишут в правильный тенант без правки кода.
-- 2) Глобальные UNIQUE на бизнес-ключах → UNIQUE(tenant_id, key).
--    Токены/сессии/beautypro_id остаются глобальными (это корректно).

BEGIN;

-- ===== 1. Функция-дефолт =====
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  )
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS tbl
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND a.attname = 'tenant_id'
      AND c.relkind = 'r' AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()', t.tbl);
  END LOOP;
END $$;

-- ===== 2. Снос глобальных UNIQUE на бизнес-ключах =====
-- Динамически: и constraint, и одиночные unique-индексы.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE con.contype = 'u'
      AND (c.relname, con.conname) IN (
        ('clients','clients_phone_key'), ('clients','clients_email_key'),
        ('clients','clients_telegram_id_key'),
        ('masters','masters_phone_key'),
        ('users','users_username_key'), ('users','users_phone_key'), ('users','users_email_key'),
        ('roles','roles_code_key'), ('branches','branches_code_key'),
        ('loyalty_tiers','loyalty_tiers_name_key'),
        ('product_variants','product_variants_sku_key'),
        ('blacklist','blacklist_client_phone_key'),
        ('birthday_bonuses','birthday_bonuses_client_phone_year_key'),
        ('favorites','favorites_client_phone_kind_target_id_key'),
        ('referrals','referrals_invited_phone_key')
      )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- ===== 3. Per-tenant UNIQUE =====
ALTER TABLE clients
  ADD CONSTRAINT clients_tenant_phone_key UNIQUE (tenant_id, phone),
  ADD CONSTRAINT clients_tenant_email_key UNIQUE (tenant_id, email),
  ADD CONSTRAINT clients_tenant_telegram_key UNIQUE (tenant_id, telegram_id);
ALTER TABLE masters
  ADD CONSTRAINT masters_tenant_phone_key UNIQUE (tenant_id, phone);
ALTER TABLE users
  ADD CONSTRAINT users_tenant_username_key UNIQUE (tenant_id, username),
  ADD CONSTRAINT users_tenant_phone_key UNIQUE (tenant_id, phone),
  ADD CONSTRAINT users_tenant_email_key UNIQUE (tenant_id, email);
ALTER TABLE roles
  ADD CONSTRAINT roles_tenant_code_key UNIQUE (tenant_id, code);
ALTER TABLE branches
  ADD CONSTRAINT branches_tenant_code_key UNIQUE (tenant_id, code);
ALTER TABLE loyalty_tiers
  ADD CONSTRAINT loyalty_tiers_tenant_name_key UNIQUE (tenant_id, name);
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_tenant_sku_key UNIQUE (tenant_id, sku);
ALTER TABLE blacklist
  ADD CONSTRAINT blacklist_tenant_phone_key UNIQUE (tenant_id, client_phone);
ALTER TABLE birthday_bonuses
  ADD CONSTRAINT birthday_bonuses_tenant_phone_year_key UNIQUE (tenant_id, client_phone, year);
ALTER TABLE favorites
  ADD CONSTRAINT favorites_tenant_key UNIQUE (tenant_id, client_phone, kind, target_id);
ALTER TABLE referrals
  ADD CONSTRAINT referrals_tenant_invited_key UNIQUE (tenant_id, invited_phone);

-- ===== 4. client_loyalty: PK client_phone → (tenant_id, client_phone) =====
ALTER TABLE client_loyalty DROP CONSTRAINT client_loyalty_pkey;
ALTER TABLE client_loyalty ADD CONSTRAINT client_loyalty_pkey PRIMARY KEY (tenant_id, client_phone);

COMMIT;
