-- 204: інвентаризація в грамах/мл (дробові кількості).
-- Було INTEGER → перерахунок фарби «45.5 г» округлявся до 45/46, розсинхрон обліку.
-- diff_qty — generated (actual - expected), тому знімаємо, міняємо базові, пересоздаємо.
ALTER TABLE inventory_audit_items DROP COLUMN IF EXISTS diff_qty;
ALTER TABLE inventory_audit_items ALTER COLUMN expected_qty TYPE NUMERIC(12,3) USING expected_qty::numeric;
ALTER TABLE inventory_audit_items ALTER COLUMN actual_qty   TYPE NUMERIC(12,3) USING actual_qty::numeric;
ALTER TABLE inventory_audit_items ADD COLUMN diff_qty NUMERIC(12,3) GENERATED ALWAYS AS (actual_qty - expected_qty) STORED;
