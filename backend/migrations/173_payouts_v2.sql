-- 173: FIN-08 Payroll / Payouts v2 — добивка модуля до спеки (tz_modules/module_07.md).
-- Только НОВОЕ, поверх существующих payroll_records / payroll_schemes / payroll_payments
-- (миграции 005 / 044). Single-salon, INTEGER SERIAL модель (как masters/kpi_*), без RLS.
-- Закрывает дельту:
--   • PayrollRule  — индивидуальные правила начисления (07.01/07.02): %/фикс по услуге/категории/филиалу;
--   • журнал пересчётов (бизнес-правило «пересчёт фиксируется в журнале», событие payroll.recalculated);
--   • частичные выплаты (07.07) — несколько выплат на один расчёт;
--   • привязка KPI-бонусов (kpi_bonuses, FIN-09) к расчётам ЗП.
BEGIN;

-- ── 173.1 Индивидуальные правила начисления (PayrollRule) ────────────────────
-- Поверх payroll_schemes (одна активная схема на мастера) — это ДЕТАЛИЗАЦИЯ:
-- отдельный %/фикс для конкретной услуги / категории услуг / филиала.
-- rule_type: percent_services | percent_products | fixed | percent_category | percent_service
CREATE TABLE IF NOT EXISTS payroll_rules (
  id            SERIAL        PRIMARY KEY,
  master_id     INTEGER       NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  rule_type     VARCHAR(30)   NOT NULL DEFAULT 'percent_services',
  scope         VARCHAR(20)   NOT NULL DEFAULT 'all',   -- all | category | service | branch
  scope_ref     TEXT,                                   -- категория / service_id / branch_id (по scope)
  percentage    NUMERIC(6,2),                           -- % для percent_* правил
  fixed_amount  NUMERIC(12,2),                          -- сумма для fixed
  priority      INTEGER       NOT NULL DEFAULT 100,     -- меньше = выше приоритет при матче
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_rules_master ON payroll_rules (master_id, is_active);
CREATE INDEX IF NOT EXISTS idx_payroll_rules_scope  ON payroll_rules (scope, scope_ref);

-- ── 173.2 Журнал пересчётов ──────────────────────────────────────────────────
-- Бизнес-правило: «пересчёт зарплаты фиксируется в журнале», событие payroll.recalculated.
-- Храним снимок до/после, чтобы выплаченный период было видно кто и почему пересчитал.
CREATE TABLE IF NOT EXISTS payroll_recalc_log (
  id            SERIAL        PRIMARY KEY,
  record_id     INTEGER       NOT NULL REFERENCES payroll_records(id) ON DELETE CASCADE,
  master_id     INTEGER,
  old_total     NUMERIC(12,2),
  new_total     NUMERIC(12,2),
  reason        TEXT,
  snapshot      JSONB,                                  -- полный breakdown на момент пересчёта
  created_by    INTEGER,
  created_by_name TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_recalc_record ON payroll_recalc_log (record_id, created_at DESC);

-- ── 173.3 Частичные выплаты (07.07) ──────────────────────────────────────────
-- payroll_payments (044) хранит ИТОГОВУЮ выплату на расчёт; здесь — журнал частичных
-- выплат, чтобы один расчёт можно было гасить несколькими траншами (аванс + остаток).
CREATE TABLE IF NOT EXISTS payroll_partial_payments (
  id            SERIAL        PRIMARY KEY,
  record_id     INTEGER       NOT NULL REFERENCES payroll_records(id) ON DELETE CASCADE,
  master_id     INTEGER,
  master_name   TEXT,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method        VARCHAR(20)   NOT NULL DEFAULT 'cash',  -- cash | card | transfer
  note          TEXT,
  cash_op_id    INTEGER,                                -- ссылка на cash_operations (если касса открыта)
  created_by    INTEGER,
  created_by_name TEXT,
  paid_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_partial_record ON payroll_partial_payments (record_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_partial_master ON payroll_partial_payments (master_id, paid_at DESC);

-- ── 173.4 Привязка KPI-бонусов к расчёту ЗП ──────────────────────────────────
-- kpi_bonuses (160, FIN-09) уже имеет payroll_id; добавим колонку-подтверждение, что
-- бонус «влит» в payroll именно через payouts-флоу (идемпотентность, аудит).
ALTER TABLE kpi_bonuses ADD COLUMN IF NOT EXISTS pulled_at TIMESTAMPTZ;

-- Колонка на payroll_records под учтённый KPI-бонус (информативно; total остаётся
-- GENERATED как percent_part+fixed_part+bonus-deduction — KPI вливается в bonus).
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS kpi_bonus NUMERIC(12,2) DEFAULT 0;

COMMIT;
