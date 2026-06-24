-- 160: FIN-09 KPI Employees — KPI сотрудников (мастеров) поверх masters/appointments.
-- Прагматична single-salon версія: метрики рахуються наживо з appointments/reviews,
-- щоденні снепшоти зберігаються для графіків. Integer SERIAL модель (як masters),
-- без tenant/RLS — single-salon, як решта старих таблиць.
BEGIN;

-- ── 160.1 Каталог метрик ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_metrics (
  id              SERIAL       PRIMARY KEY,
  code            VARCHAR(50)  NOT NULL UNIQUE,    -- revenue|avg_check|occupancy|...
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  unit            VARCHAR(20)  NOT NULL DEFAULT 'count',  -- uah|percent|count|rating|seconds
  direction       VARCHAR(10)  NOT NULL DEFAULT 'higher', -- higher|lower (для no-show lower=краще)
  agg             VARCHAR(10)  NOT NULL DEFAULT 'sum',     -- sum|avg (агрегація щоденних у період)
  applicable_roles TEXT[]      DEFAULT ARRAY['master'],
  default_weight  NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── 160.2 Плани (targets) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_targets (
  id           SERIAL       PRIMARY KEY,
  master_id    INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  metric_code  VARCHAR(50)  NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  target_value NUMERIC(12,2) NOT NULL,
  weight       NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  approved_by  INTEGER,
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (master_id, metric_code, period_start)
);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_master ON kpi_targets (master_id, period_start);

-- ── 160.3 Факт (щоденні снепшоти) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_actuals (
  id           SERIAL       PRIMARY KEY,
  master_id    INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  metric_code  VARCHAR(50)  NOT NULL,
  date         DATE         NOT NULL,
  value        NUMERIC(12,2) NOT NULL DEFAULT 0,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (master_id, metric_code, date)
);
CREATE INDEX IF NOT EXISTS idx_kpi_actuals_master_date ON kpi_actuals (master_id, date);
CREATE INDEX IF NOT EXISTS idx_kpi_actuals_metric ON kpi_actuals (metric_code, date);

-- ── 160.4 Бонуси за KPI ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_bonuses (
  id                  SERIAL       PRIMARY KEY,
  master_id           INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  period_start        DATE         NOT NULL,
  period_end          DATE         NOT NULL,
  achievement_percent NUMERIC(6,2),
  bonus_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  bonus_scheme        JSONB,
  status              VARCHAR(20)  NOT NULL DEFAULT 'calculated',  -- calculated|approved|paid
  payroll_id          INTEGER,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (master_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_kpi_bonuses_period ON kpi_bonuses (period_start, status);

-- ── 160.5 Досягнення (бейджі) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_achievements (
  id         SERIAL       PRIMARY KEY,
  master_id  INTEGER      NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  badge_code VARCHAR(50)  NOT NULL,
  badge_name VARCHAR(100),
  earned_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  period     VARCHAR(20),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (master_id, badge_code, period)
);

-- ── 160.6 Сід каталогу метрик ────────────────────────────────────────────────
INSERT INTO kpi_metrics (code, name, description, unit, direction, agg, default_weight) VALUES
  ('revenue',      'Виручка',           'Сума оплат за послуги майстра',        'uah',     'higher', 'sum', 0.40),
  ('avg_check',    'Середній чек',      'Виручка / кількість візитів',          'uah',     'higher', 'avg', 0.10),
  ('visits',       'Візити',            'Кількість виконаних візитів',          'count',   'higher', 'sum', 0.10),
  ('occupancy',    'Завантаження',      'Зайняті хвилини / робочі хвилини',     'percent', 'higher', 'avg', 0.15),
  ('repeat_rate',  'Повторні візити',   'Клієнти з >1 візитом / усі клієнти',   'percent', 'higher', 'avg', 0.10),
  ('noshow_rate',  'Неявки',            'Неявки / усі записи',                  'percent', 'lower',  'avg', 0.05),
  ('new_clients',  'Нові клієнти',      'Первинні візити',                      'count',   'higher', 'sum', 0.05),
  ('rating',       'Рейтинг',           'Середній бал відгуків',                'rating',  'higher', 'avg', 0.05),
  ('product_sales','Продаж товарів',    'Допродажі товарів на візиті',          'uah',     'higher', 'sum', 0.00)
ON CONFLICT (code) DO NOTHING;

COMMIT;
