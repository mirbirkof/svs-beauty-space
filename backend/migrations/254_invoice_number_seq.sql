-- 254: атомарная нумерация счетов SaaS (аудит v6, биллинг #5).
-- nextInvoiceNumber() делал count(*)+1 — два конкурентных счёта получали один номер,
-- второй падал об UNIQUE(invoice_number) без ретрая. Sequence выдаёт номер атомарно.
-- Стартуем с текущего максимального хвоста, чтобы не пересечься с существующими.
DO $$
DECLARE m BIGINT;
BEGIN
  SELECT COALESCE(MAX(NULLIF(substring(invoice_number FROM '[0-9]+$'), '')::bigint), 0)
    INTO m FROM invoices_saas;
  IF to_regclass('public.invoice_number_seq') IS NULL THEN
    EXECUTE format('CREATE SEQUENCE invoice_number_seq START WITH %s', m + 1);
  ELSE
    PERFORM setval('invoice_number_seq', GREATEST(m, 1), m > 0);
  END IF;
END $$;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE invoice_number_seq TO app_tenant;
