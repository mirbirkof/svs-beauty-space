-- 238_promos_per_tenant.sql
-- ПРЕСЕЙЛ-БЛОКЕР #6: таблица promos (промокоды магазина) — ГЛОБАЛЬНАЯ.
-- PK = code TEXT на всю платформу: промокод салона A действует в салоне B и жрёт общий
-- счётчик max_uses; ai-kb/ai-marketing инжектят коды всех салонов в AI-контекст каждого.
-- Таблица создаётся только в bootstrap routes/promos.js (миграции не было) — на момент
-- старта её может ещё не быть, поэтому обрабатываем оба случая.
--
-- Решение: tenant_id uuid DEFAULT current_tenant_id(), composite PK (tenant_id, code),
-- ENABLE+FORCE RLS + политика tenant_isolation. Существующие промокоды получают tenant_id
-- дефолтного салона (Босса). Идемпотентно.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='promos') THEN
    CREATE TABLE promos (
      tenant_id    uuid NOT NULL DEFAULT current_tenant_id(),
      code         TEXT NOT NULL,
      type         TEXT NOT NULL CHECK (type IN ('percent','fixed')),
      value        NUMERIC NOT NULL,
      min_total    NUMERIC DEFAULT 0,
      max_uses     INT,
      uses         INT DEFAULT 0,
      valid_until  TIMESTAMPTZ,
      active       BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, code)
    );
  ELSE
    -- таблица уже есть со старой схемой (глобальный PK по code) — доводим до per-tenant
    ALTER TABLE promos ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();
    -- пересобрать PK в (tenant_id, code), если он ещё не такой
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid='promos'::regclass AND contype='p'
         -- attname имеет тип name → приводим к text, иначе "operator does not exist: name[] = text[]"
         AND (SELECT array_agg(attname::text ORDER BY attname)
                FROM pg_attribute
               WHERE attrelid='promos'::regclass AND attnum = ANY(conkey))
             = ARRAY['code','tenant_id']
    ) THEN
      ALTER TABLE promos DROP CONSTRAINT IF EXISTS promos_pkey;
      ALTER TABLE promos ADD PRIMARY KEY (tenant_id, code);
    END IF;
  END IF;

  -- RLS (идемпотентно; boot-time ensure-rls подхватит на будущее автоматически)
  EXECUTE 'ALTER TABLE promos ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE promos FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON promos';
  EXECUTE 'CREATE POLICY tenant_isolation ON promos '
       || 'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
       || 'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))';
END $$;
