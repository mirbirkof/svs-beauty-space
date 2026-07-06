-- 224: явний прапорець «рядок-послуга є матеріалом» (SaaS-аудит 06.07).
-- Досі матеріал у складі візиту розпізнавався за назвою (~ 'матеріал' без 'без'/'врахуванн').
-- Для нового салону з іншим неймінгом (рос./англ./інша схема) евристика мовчки дала б
-- іншу базу % → неправильна ЗП з першого дня. Тепер: явний прапорець, евристика — лише
-- дефолт-бекфіл для існуючих даних. payroll-base читає прапорець, з fallback на назву.
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_material BOOLEAN NOT NULL DEFAULT FALSE;

-- backfill існуючих послуг евристикою (та сама, що в lib/payroll-base)
UPDATE services SET is_material = TRUE
 WHERE is_material = FALSE
   AND LOWER(COALESCE(name,'')) ~ 'матер[іи]ал'
   AND LOWER(COALESCE(name,'')) NOT LIKE '%без%'
   AND LOWER(COALESCE(name,'')) NOT LIKE '%врахуванн%';
