-- Расходники (краски и материалы мастеров) не дают % продавцу
ALTER TABLE categories ADD COLUMN IF NOT EXISTS commissionable BOOLEAN DEFAULT TRUE;
UPDATE categories SET commissionable = FALSE WHERE id IN ('coloring','oxidant','bleach','pigment','perm');
