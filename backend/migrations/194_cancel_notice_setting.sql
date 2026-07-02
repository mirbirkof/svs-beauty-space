-- 194 Правило отмены/переноса визита клиентом (CRM-05 / M20 Cabinet)
-- За сколько минут до визита клиент ещё может отменить/перенести сам.
-- Оживляет booking_settings (была таблицей-сиротой с 061).

ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS cancel_notice_minutes INTEGER NOT NULL DEFAULT 120;
