-- 296_store_inventory.sql — SLS-11: инвентаризация склада МАГАЗИНА (warehouse_stock, warehouse_id='store').
-- Отдельно от салонной инвентаризации (inventory_audits / product_variants.stock_qty — routes/inventory.js,
-- НЕ трогается). Аддитивно.
--
-- Урок сегодняшнего бага салона: при закрытии дельта считается против ТЕКУЩЕГО остатка на момент
-- закрытия, а не против снапшота на старте акта — иначе движения (приёмки/продажи), случившиеся пока
-- акт открыт, стираются. См. routes/store.js close-хендлер.

CREATE TABLE IF NOT EXISTS store_inventory_acts (
  id         SERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id(),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  note       TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at  TIMESTAMPTZ
);

-- один открытый акт на тенанта одновременно
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_inventory_acts_open
  ON store_inventory_acts (tenant_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS store_inventory_lines (
  act_id       INTEGER NOT NULL REFERENCES store_inventory_acts(id) ON DELETE CASCADE,
  variant_id   INTEGER NOT NULL REFERENCES product_variants(id),
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  expected_qty NUMERIC(12,3),           -- остаток на момент ВВОДА строки — справочно
  counted_qty  NUMERIC(12,3),
  counted_by   TEXT,
  counted_at   TIMESTAMPTZ,
  PRIMARY KEY (act_id, variant_id)
);

-- RLS: тот же контур мультиарендности, что и у остальных таблиц магазина (эталон миграции 291,
-- где политика вешалась и на дочерние *_items таблицы, а не только на шапки).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_inventory_acts','store_inventory_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;
