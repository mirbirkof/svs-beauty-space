-- ═══════════════════════════════════════════════════════
-- CRM-09 — Профіль співробітника в стилі DIKIDI
-- Додаткові поля картки: прізвище, email, категорія.
-- Усі nullable, additive — нічого не ламає.
-- ═══════════════════════════════════════════════════════

ALTER TABLE masters ADD COLUMN IF NOT EXISTS surname TEXT;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS category TEXT;
