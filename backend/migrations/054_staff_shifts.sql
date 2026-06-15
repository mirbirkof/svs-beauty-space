-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ SAL-05 (15.06) — Зміни співробітників + табель + clock-in/out
-- Планові робочі зміни майстрів, фактичний прихід/вихід (відмітки),
-- агрегат відпрацьованих годин (табель обліку робочого часу).
-- Не плутати з cash_shifts (касові зміни) — це робочий графік персоналу.
-- Інтегрується в журнал/розклад. Доступ: schedule.read / schedule.write.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staff_shifts (
  id            SERIAL PRIMARY KEY,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  branch_id     INTEGER,
  shift_date    DATE NOT NULL,
  planned_start TIME,                       -- запланований початок зміни
  planned_end   TIME,                       -- запланований кінець зміни
  clock_in      TIMESTAMPTZ,                -- фактична відмітка приходу
  clock_out     TIMESTAMPTZ,                -- фактична відмітка виходу
  status        TEXT DEFAULT 'planned',     -- planned|working|done|missed
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (master_id, shift_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_date   ON staff_shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_master ON staff_shifts(master_id, shift_date);
