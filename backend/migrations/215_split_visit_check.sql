-- Розділення чека візиту в касі: послуга → sale_service, платні матеріали/товари → sale_product.
-- Раніше весь чек писався однією операцією sale_service, тому «товари» у фінзведенні завжди 0,
-- а база % майстра була завищена на вартість матеріалів.
-- Дві операції з одним method потребують category в унікальному індексі ідемпотентності.
DROP INDEX IF EXISTS ux_cash_ops_appt_payment;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ops_appt_payment
  ON cash_operations (tenant_id, ref_type, ref_id, method, category)
  WHERE type = 'in' AND ref_type = 'appointment';
