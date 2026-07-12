-- 255: PO-номера закупок — per-tenant (аудит v6, склад #1).
-- po_number имел ГЛОБАЛЬНЫЙ UNIQUE: второй салон при создании своей первой закупки
-- получал 'PO-2026-0001', ловил конфликт с закупкой первого салона → 500, модуль
-- закупок для арендаторов не работал. Нумерация у каждого салона своя.
BEGIN;
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_po_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_po_tenant_number ON purchase_orders (tenant_id, po_number);
COMMIT;
