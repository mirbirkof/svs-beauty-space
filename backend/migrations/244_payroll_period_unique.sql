-- Major #8: захист від подвійного розрахунку ЗП (TOCTOU). Раніше два паралельні
-- /calculate проходили SELECT-перевірку й обидва вставляли розрахунок на той самий
-- період. Частковий UNIQUE-індекс закриває гонку на рівні БД для точного періоду
-- (найчастіший кейс — подвійний клік). Скасовані не рахуються.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_active_period
  ON payroll_records (tenant_id, master_id, period_start)
  WHERE status <> 'cancelled';
