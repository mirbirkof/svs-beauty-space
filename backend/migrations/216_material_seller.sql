-- Продавець матеріалу/банки у візиті (кейс Босса 06.07):
-- клієнтку робила Світлана, а косметику продала Відюк — % з продажу має піти Відюк.
-- NULL = продав майстер візиту (поведінка за замовчуванням).
ALTER TABLE appointment_materials ADD COLUMN IF NOT EXISTS seller_master_id INTEGER;
