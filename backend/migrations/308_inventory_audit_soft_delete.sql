-- 30.09 (Босс: «власник має видаляти зайві акти інвентаризації, щоб зникли зі списку»).
-- Мягкое удаление: строки акта и шапка ФИЗИЧЕСКИ не стираются (запрет дневника CRM) —
-- удалённый акт только скрывается из списка и карточки. Кто и когда удалил — здесь же.
-- Удалять можно лишь непроведённый акт (in_progress/cancelled): у него к остатку ничего
-- не применено (перенос в stock_qty — только при проведении, applied_qty пуст).
-- Миграция идемпотентна.
ALTER TABLE inventory_audits ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE inventory_audits ADD COLUMN IF NOT EXISTS deleted_by TEXT;
