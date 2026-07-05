-- 212: подключаемое право «Склад і ціни» (stock.manage)
-- Задача Босса: у администратора редактирование склада и установка цен —
-- не по умолчанию, а персональным тумблером в «Керуванні доступом».

-- Персональные права поверх роли (JSONB-массив кодов, например ["stock.manage"])
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- admin: было stock.* (полный склад всегда). Теперь по умолчанию:
--   stock.read  — видеть склад/остатки
--   stock.write — материалы в визитах (ежедневная работа, НЕ трогаем)
-- Редактирование склада, накладные, инвентаризация, закупки и цены = stock.manage,
-- включается персонально.
UPDATE roles SET permissions = (permissions - 'stock.*') || '["stock.read","stock.write"]'::jsonb
 WHERE code = 'admin' AND permissions ? 'stock.*';

-- manager (керуючий): сохраняет полные права на склад, как было
UPDATE roles SET permissions = permissions || '["stock.manage"]'::jsonb
 WHERE code = 'manager' AND NOT permissions ? 'stock.manage';
