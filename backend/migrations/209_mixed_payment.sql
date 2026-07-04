-- Змішана оплата візиту (готівка + картка): дві касові операції на один запис.
-- Унікальність тепер (tenant, ref, method) — ідемпотентність збережена per-method.
DROP INDEX IF EXISTS ux_cash_ops_appt_payment;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ops_appt_payment
  ON cash_operations (tenant_id, ref_type, ref_id, method)
  WHERE type = 'in' AND ref_type = 'appointment';
