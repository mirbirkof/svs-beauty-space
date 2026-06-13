-- 035: Per-date робочий графік майстрів з BeautyPro (/schedule)
-- /employees.worktime порожній → реальне джерело графіків це /schedule (по даті).
-- Журнал читає цю таблицю першою, fallback на тижневий masters.schedule_json.
CREATE TABLE IF NOT EXISTS master_schedule_days (
  id          SERIAL PRIMARY KEY,
  master_id   INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  work_date   DATE NOT NULL,
  start_time  TIME,                 -- NULL = вихідний цього дня
  end_time    TIME,
  source      TEXT DEFAULT 'beautypro',
  synced_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (master_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_msd_date ON master_schedule_days(work_date);
