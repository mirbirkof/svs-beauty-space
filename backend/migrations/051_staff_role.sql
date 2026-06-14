-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ CRM-09 — Розмежування персоналу (заметка #13)
-- Адміністратори (Аліна, Юлія) НЕ надають послуги, але
-- з'являлися в журналі як майстри-колонки. Додаємо ознаку
-- provides_services: майстер оказує послуги → колонка в журналі;
-- адміністратор → прибраний із журналу/онлайн-запису, але лишається
-- співробітником (зарплата, доступ, права).
-- staff_role — явна роль для UI-маркування.
-- ═══════════════════════════════════════════════════════

ALTER TABLE masters ADD COLUMN IF NOT EXISTS provides_services BOOLEAN DEFAULT true;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS staff_role TEXT;

-- Існуючі адміністратори: помітити як таких, що НЕ надають послуги.
UPDATE masters
   SET provides_services = false,
       staff_role = 'admin'
 WHERE provides_services IS DISTINCT FROM false
   AND specialty ILIKE '%адмін%';

-- Решта активних — майстри (default provides_services=true).
UPDATE masters
   SET staff_role = 'master'
 WHERE staff_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_masters_provides ON masters(provides_services) WHERE active = true;
