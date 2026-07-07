-- 226: изоляция stock_import_docs по тенанту (предпродажный аудит 07.07.2026).
-- Таблица накладных/прайсов склада (kind, filename, items jsonb, totals jsonb)
-- была создана без tenant_id и без RLS — второй салон видел бы накладные и
-- закупочные цены первого. items хранятся в jsonb ВНУТРИ этой же таблицы,
-- отдельной stock_import_items нет — защищаем одну таблицу.
-- Паттерн идентичен 222 (DEFAULT current_tenant_id() backfill'ит существующие
-- строки в тенант Босса, RLS-политика — как 015/126/136/222).

-- ── 1. tenant_id ──
ALTER TABLE public.stock_import_docs
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();

-- backfill существующих строк на всякий случай (если GUC был задан при ALTER)
UPDATE public.stock_import_docs
  SET tenant_id = '00000000-0000-0000-0000-000000000001'
  WHERE tenant_id IS NULL;

-- ── 2. RLS (fail-closed при заданном GUC, permissive без него — кроны/скрипты) ──
ALTER TABLE public.stock_import_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_import_docs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.stock_import_docs;
CREATE POLICY tenant_isolation ON public.stock_import_docs
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- ── 3. индекс под фильтр по тенанту ──
CREATE INDEX IF NOT EXISTS idx_stock_import_docs_tenant ON public.stock_import_docs(tenant_id);
