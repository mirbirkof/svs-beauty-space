-- 294_store_cash.sql — SLS-11 этап 5: денежный контур магазина (отдельно от кассы салона).
-- Без ручных смен: день закрывается сам, операции пишутся автоматически из продаж и поставок.
-- ПРАВИЛО ПРОЕКТА (усвоено 12.08): новая таблица создаётся сразу с tenant_id + tenant_isolation,
-- иначе event-trigger включает RLS без политики и запись из приложения отбивается.

CREATE TABLE IF NOT EXISTS store_cash_ops (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  category    TEXT NOT NULL,                    -- sale | debt_payment | purchase | delivery | expense | other
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method      TEXT NOT NULL DEFAULT 'bank' CHECK (method IN ('cash','bank','card')),
  ref_type    TEXT,                             -- store_sale | store_receipt | manual
  ref_id      INTEGER,
  op_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  notes       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_cash_date ON store_cash_ops(op_date);
CREATE INDEX IF NOT EXISTS idx_store_cash_ref ON store_cash_ops(ref_type, ref_id);

ALTER TABLE store_cash_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_cash_ops FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON store_cash_ops;
CREATE POLICY tenant_isolation ON store_cash_ops
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- Отметка «поставка оплачена поставщику»: расход в кассу пишется только по факту оплаты,
-- иначе баланс врал бы при работе с отсрочкой от поставщика.
ALTER TABLE store_receipts ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
