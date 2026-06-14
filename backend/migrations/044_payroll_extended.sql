-- ═══════════════════════════════════════════════════════
-- МОДУЛЬ 07 — Зарплата: бонусы, штрафы, авансы, история выплат
-- Заметка #7: модуль был ~50%. Добавляем сущности по module_07.md.
-- GENERATED-формулу payroll_records.total НЕ трогаем:
--   total = percent_part + fixed_part + sales_part + bonus - deduction
-- При расчёте period: bonus = SUM(bonuses), deduction = SUM(penalties)+SUM(unsettled advances).
-- ═══════════════════════════════════════════════════════

-- ── 07.04 Бонусы (KPI, премии, разовые, мотивация) ──
CREATE TABLE IF NOT EXISTS payroll_bonuses (
  id           SERIAL PRIMARY KEY,
  master_id    TEXT NOT NULL,
  master_name  TEXT,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  kind         TEXT NOT NULL DEFAULT 'onetime',   -- kpi|premium|onetime|motivation
  reason       TEXT,
  bonus_date   DATE NOT NULL DEFAULT CURRENT_DATE, -- к какой дате/периоду относится
  applied_record_id INTEGER,                       -- в какой расчёт включён (NULL = ещё не учтён)
  created_by   INTEGER,
  created_by_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payroll_bonuses_master_idx ON payroll_bonuses(master_id, bonus_date);

-- ── 07.05 Штрафы (ручные, авто, удержания за нарушения) ──
CREATE TABLE IF NOT EXISTS payroll_penalties (
  id           SERIAL PRIMARY KEY,
  master_id    TEXT NOT NULL,
  master_name  TEXT,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  kind         TEXT NOT NULL DEFAULT 'manual',     -- manual|auto|violation
  reason       TEXT,
  penalty_date DATE NOT NULL DEFAULT CURRENT_DATE,
  applied_record_id INTEGER,
  created_by   INTEGER,
  created_by_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payroll_penalties_master_idx ON payroll_penalties(master_id, penalty_date);

-- ── 07.06 Авансы (выдача, учёт, авто-вычет при расчёте) ──
CREATE TABLE IF NOT EXISTS payroll_advances (
  id           SERIAL PRIMARY KEY,
  master_id    TEXT NOT NULL,
  master_name  TEXT,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  reason       TEXT,
  issued_at    DATE NOT NULL DEFAULT CURRENT_DATE,
  method       TEXT DEFAULT 'cash',                -- cash|card|transfer
  settled      BOOLEAN NOT NULL DEFAULT FALSE,     -- вычтен из расчёта?
  settled_record_id INTEGER,
  created_by   INTEGER,
  created_by_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payroll_advances_master_idx ON payroll_advances(master_id, issued_at);

-- ── 07.07 История выплат ──
CREATE TABLE IF NOT EXISTS payroll_payments (
  id           SERIAL PRIMARY KEY,
  master_id    TEXT NOT NULL,
  master_name  TEXT,
  record_id    INTEGER,                            -- какой расчёт оплачен
  amount       NUMERIC(12,2) NOT NULL,
  method       TEXT DEFAULT 'cash',                -- cash|card|transfer
  period_start DATE,
  period_end   DATE,
  paid_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by   INTEGER,
  created_by_name TEXT,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS payroll_payments_master_idx ON payroll_payments(master_id, paid_at DESC);
