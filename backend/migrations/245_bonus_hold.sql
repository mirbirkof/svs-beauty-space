-- Major #10: hold-період бонусів (анти-фрод). available_at — коли нарахування стає
-- доступним до списання. Наявні бонуси backfill'имо created_at → одразу доступні
-- (не заморожуємо заднім числом). Нові accrual отримають now()+hold_period_days.
ALTER TABLE bonus_transactions ADD COLUMN IF NOT EXISTS available_at timestamptz;
UPDATE bonus_transactions SET available_at = created_at WHERE available_at IS NULL;
