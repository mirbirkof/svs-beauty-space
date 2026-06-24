-- 180: INF-07 Data Warehouse v2 — аналитическое хранилище (star-schema) поверх OLTP.
-- Прагматична single-salon реалізація специфікації INF-07:
--   • реєстр ETL-джобів (dwh_etl_jobs) з розкладом/залежностями/конфігом;
--   • лог виконань ETL (dwh_etl_logs) зі статусом/рядками/quality_score/reconciliation;
--   • реєстр джерел даних (dwh_data_sources) з health-check;
--   • star-schema: вимірювання (dwh_dim_time/clients/services/staff/products)
--     + факти (dwh_fact_visits_v2/sales/payments/staff_payroll).
-- Усе наповнюється ETL наживо з OLTP (appointments/orders/cash_operations/
-- payroll_records/stock_movements/clients/masters/services/product_variants).
-- Зовнішні BI (BigQuery/Snowflake/Redshift) — graceful-стаб у dwh_data_sources.
--
-- Integer SERIAL модель (як masters/branches/appointments — id = SERIAL),
-- без UUID/окремої схеми dwh: міграції виконуються в public. Префікс dwh_*
-- щоб не зачіпати старі dwh_fact_visits/dwh_etl_runs (міграція 116) —
-- ті лишаються як legacy, цей модуль розширює їх. Усе IF NOT EXISTS — ідемпотентно.
BEGIN;

-- ════════════════════ 180.1 РЕЄСТР ETL-ДЖОБІВ ════════════════════
-- Каталог ETL-задач: full_load|incremental|cdc|refresh_mv, з cron-розкладом,
-- пріоритетом, залежностями (порядок dimensions → facts) та конфігом трансформації.
CREATE TABLE IF NOT EXISTS dwh_etl_jobs (
  id              SERIAL        PRIMARY KEY,
  name            VARCHAR(128)  NOT NULL UNIQUE,        -- "load_fact_visits", "refresh_mv_revenue"
  description     TEXT,
  job_type        VARCHAR(16)   NOT NULL DEFAULT 'incremental', -- full_load|incremental|cdc|refresh_mv
  source_table    VARCHAR(128),                          -- таблиця-джерело в OLTP
  target_table    VARCHAR(128)  NOT NULL,                -- таблиця-ціль у DWH
  cron_expression VARCHAR(64)   NOT NULL DEFAULT '*/15 * * * *',
  priority        INTEGER       NOT NULL DEFAULT 5,
  depends_on      INTEGER[]     NOT NULL DEFAULT '{}',   -- залежності (інші job id)
  config          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  last_status     VARCHAR(16),                           -- останній статус виконання
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_etl_jobs_active ON dwh_etl_jobs (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_dwh_etl_jobs_target ON dwh_etl_jobs (target_table);

-- ════════════════════ 180.2 ЛОГ ВИКОНАНЬ ETL ════════════════════
-- Історія прогонів: статус, кількість витягнутих/трансформованих/завантажених/
-- відхилених рядків, quality_score (0-100), reconciliation (OLTP vs DWH).
CREATE TABLE IF NOT EXISTS dwh_etl_logs (
  id               SERIAL        PRIMARY KEY,
  job_id           INTEGER       NOT NULL REFERENCES dwh_etl_jobs(id) ON DELETE CASCADE,
  status           VARCHAR(16)   NOT NULL DEFAULT 'running', -- running|completed|failed|skipped
  rows_extracted   BIGINT        NOT NULL DEFAULT 0,
  rows_transformed BIGINT        NOT NULL DEFAULT 0,
  rows_loaded      BIGINT        NOT NULL DEFAULT 0,
  rows_rejected    BIGINT        NOT NULL DEFAULT 0,
  quality_score    NUMERIC(5,2),                          -- 0.00 - 100.00
  reconciliation   JSONB,                                 -- { oltp_sum, dwh_sum, diff_pct }
  trigger_kind     VARCHAR(16)   NOT NULL DEFAULT 'manual', -- manual|scheduled|cdc
  error_message    TEXT,
  started_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  duration_sec     INTEGER       GENERATED ALWAYS AS
                     (CASE WHEN completed_at IS NULL THEN NULL
                           ELSE EXTRACT(EPOCH FROM (completed_at - started_at))::int END) STORED
);
CREATE INDEX IF NOT EXISTS idx_dwh_etl_logs_job ON dwh_etl_logs (job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dwh_etl_logs_status ON dwh_etl_logs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dwh_etl_logs_date ON dwh_etl_logs (started_at DESC);

-- ════════════════════ 180.3 ДЖЕРЕЛА ДАНИХ ════════════════════
-- Реєстр джерел: основна OLTP-БД (postgresql) + зовнішні BI як graceful-стаб
-- (bigquery/snowflake/redshift — health=unknown поки не сконфігуровано).
CREATE TABLE IF NOT EXISTS dwh_data_sources (
  id                SERIAL        PRIMARY KEY,
  name              VARCHAR(128)  NOT NULL UNIQUE,       -- "main_oltp", "bigquery_export"
  source_type       VARCHAR(16)   NOT NULL DEFAULT 'postgresql', -- postgresql|api|file|kafka|bigquery|snowflake|redshift
  connection_config JSONB         NOT NULL DEFAULT '{}'::jsonb,  -- { host, port, db, schema }
  health_status     VARCHAR(8)    NOT NULL DEFAULT 'unknown',    -- healthy|degraded|down|unknown
  last_health_check TIMESTAMPTZ,
  tables_available  TEXT[]        NOT NULL DEFAULT '{}',
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_sources_active ON dwh_data_sources (is_active);

-- ════════════════════ 180.4 ВИМІРЮВАННЯ (DIMENSIONS) ════════════════════
-- Surrogate integer keys для join-performance. SCD Type 2 (valid_from/valid_to/
-- is_current) на dim_clients/services/staff/products. Natural key = *_src_id (OLTP).

-- dim_time: календарний вимір (time_key = YYYYMMDD)
CREATE TABLE IF NOT EXISTS dwh_dim_time (
  time_key      INTEGER       PRIMARY KEY,               -- YYYYMMDD
  full_date     DATE          NOT NULL UNIQUE,
  year          SMALLINT      NOT NULL,
  quarter       SMALLINT      NOT NULL,
  month         SMALLINT      NOT NULL,
  month_name    VARCHAR(16)   NOT NULL,
  week          SMALLINT      NOT NULL,
  day_of_week   SMALLINT      NOT NULL,                  -- 1=Пн
  day_name      VARCHAR(16)   NOT NULL,
  is_weekend    BOOLEAN       NOT NULL DEFAULT FALSE,
  is_holiday    BOOLEAN       NOT NULL DEFAULT FALSE,
  fiscal_period VARCHAR(8)
);

CREATE TABLE IF NOT EXISTS dwh_dim_clients (
  client_key       SERIAL       PRIMARY KEY,             -- surrogate key
  client_src_id    INTEGER      NOT NULL,                -- natural key з OLTP (clients.id)
  full_name        VARCHAR(256),
  phone_hash       VARCHAR(64),
  gender           VARCHAR(1),
  age_group        VARCHAR(16),
  segment          VARCHAR(32),                          -- VIP|Regular|New|Churned
  first_visit_date DATE,
  source           VARCHAR(64),
  valid_from       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  valid_to         TIMESTAMPTZ  NOT NULL DEFAULT '9999-12-31',
  is_current       BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (client_src_id, is_current)
);
CREATE INDEX IF NOT EXISTS idx_dwh_dim_clients_src ON dwh_dim_clients (client_src_id, is_current);

CREATE TABLE IF NOT EXISTS dwh_dim_services (
  service_key    SERIAL       PRIMARY KEY,
  service_src_id INTEGER      NOT NULL,
  name           VARCHAR(256),
  category       VARCHAR(128),
  subcategory    VARCHAR(128),
  base_price     NUMERIC(12,2),
  duration_min   INTEGER,
  valid_from     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  valid_to       TIMESTAMPTZ  NOT NULL DEFAULT '9999-12-31',
  is_current     BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (service_src_id, is_current)
);
CREATE INDEX IF NOT EXISTS idx_dwh_dim_services_src ON dwh_dim_services (service_src_id, is_current);

CREATE TABLE IF NOT EXISTS dwh_dim_staff (
  staff_key      SERIAL       PRIMARY KEY,
  staff_src_id   INTEGER      NOT NULL,
  full_name      VARCHAR(256),
  role           VARCHAR(64),
  specialization VARCHAR(128),
  branch_id      INTEGER,
  branch_name    VARCHAR(256),
  hire_date      DATE,
  valid_from     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  valid_to       TIMESTAMPTZ  NOT NULL DEFAULT '9999-12-31',
  is_current     BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (staff_src_id, is_current)
);
CREATE INDEX IF NOT EXISTS idx_dwh_dim_staff_src ON dwh_dim_staff (staff_src_id, is_current);

CREATE TABLE IF NOT EXISTS dwh_dim_products (
  product_key    SERIAL       PRIMARY KEY,
  product_src_id INTEGER      NOT NULL,                  -- product_variants.id
  name           VARCHAR(256),
  brand          VARCHAR(128),
  category       VARCHAR(128),
  sku            VARCHAR(64),
  cost_price     NUMERIC(12,2),
  retail_price   NUMERIC(12,2),
  valid_from     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  valid_to       TIMESTAMPTZ  NOT NULL DEFAULT '9999-12-31',
  is_current     BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (product_src_id, is_current)
);
CREATE INDEX IF NOT EXISTS idx_dwh_dim_products_src ON dwh_dim_products (product_src_id, is_current);

-- ════════════════════ 180.5 ФАКТИ (FACT TABLES) ════════════════════
-- Партиціонування зі специфікації спрощено до індексів по даті (single-salon,
-- pg-партиції надлишкові). Surrogate keys → dimensions. Generated-колонки для
-- margin/net_amount/total_payout як у спеці.

-- fact_visits: візити клієнтів (джерело appointments)
CREATE TABLE IF NOT EXISTS dwh_fact_visits_v2 (
  id              SERIAL        PRIMARY KEY,
  visit_src_id    INTEGER       NOT NULL UNIQUE,         -- appointments.id (CDC dedup)
  time_key        INTEGER       REFERENCES dwh_dim_time(time_key),
  client_key      INTEGER       REFERENCES dwh_dim_clients(client_key),
  staff_key       INTEGER       REFERENCES dwh_dim_staff(staff_key),
  service_key     INTEGER       REFERENCES dwh_dim_services(service_key),
  branch_id       INTEGER,
  visit_date      DATE          NOT NULL,
  visit_time      TIME,
  duration_min    INTEGER,
  status          VARCHAR(16)   NOT NULL,                -- completed|cancelled|no_show
  revenue         NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_first_visit  BOOLEAN       NOT NULL DEFAULT FALSE,
  source          VARCHAR(64),
  loaded_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_fact_visits_v2_date ON dwh_fact_visits_v2 (visit_date);
CREATE INDEX IF NOT EXISTS idx_dwh_fact_visits_v2_staff ON dwh_fact_visits_v2 (staff_key, visit_date);

-- fact_sales: продажі товарів (джерело order_items + orders)
CREATE TABLE IF NOT EXISTS dwh_fact_sales (
  id            SERIAL        PRIMARY KEY,
  sale_src_id   INTEGER       NOT NULL UNIQUE,           -- order_items.id
  order_id      INTEGER,
  time_key      INTEGER       REFERENCES dwh_dim_time(time_key),
  client_key    INTEGER       REFERENCES dwh_dim_clients(client_key),
  product_key   INTEGER       REFERENCES dwh_dim_products(product_key),
  branch_id     INTEGER,
  sale_date     DATE          NOT NULL,
  quantity      INTEGER       NOT NULL DEFAULT 0,
  unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  margin        NUMERIC(12,2) GENERATED ALWAYS AS (total_amount - cost_amount) STORED,
  loaded_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_fact_sales_date ON dwh_fact_sales (sale_date);

-- fact_payments: платежі (джерело cash_operations type=in)
CREATE TABLE IF NOT EXISTS dwh_fact_payments (
  id             SERIAL        PRIMARY KEY,
  payment_src_id INTEGER       NOT NULL UNIQUE,          -- cash_operations.id
  time_key       INTEGER       REFERENCES dwh_dim_time(time_key),
  client_key     INTEGER       REFERENCES dwh_dim_clients(client_key),
  branch_id      INTEGER,
  payment_date   DATE          NOT NULL,
  payment_method VARCHAR(32)   NOT NULL DEFAULT 'cash',  -- cash|card|online|transfer|mono
  category       VARCHAR(64),
  amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  refund_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount     NUMERIC(12,2) GENERATED ALWAYS AS (amount + tip_amount - refund_amount) STORED,
  loaded_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_fact_payments_date ON dwh_fact_payments (payment_date);

-- fact_staff_payroll: зарплати майстрів (джерело payroll_records)
CREATE TABLE IF NOT EXISTS dwh_fact_staff_payroll (
  id            SERIAL        PRIMARY KEY,
  payroll_src_id INTEGER      NOT NULL UNIQUE,           -- payroll_records.id
  time_key      INTEGER       REFERENCES dwh_dim_time(time_key),
  staff_key     INTEGER       REFERENCES dwh_dim_staff(staff_key),
  branch_id     INTEGER,
  period_date   DATE          NOT NULL,                  -- перший день періоду
  base_salary   NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission    NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonus         NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_payout  NUMERIC(12,2) GENERATED ALWAYS AS (base_salary + commission + bonus - deductions) STORED,
  visits_count  INTEGER       NOT NULL DEFAULT 0,
  clients_count INTEGER       NOT NULL DEFAULT 0,
  loaded_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwh_fact_payroll_date ON dwh_fact_staff_payroll (period_date);

-- ════════════════════ 180.6 СІД РЕЄСТРУ ETL-ДЖОБІВ ════════════════════
-- Порядок: dimensions (priority 1) → facts (priority 5) → materialized views (priority 9).
INSERT INTO dwh_etl_jobs (name, description, job_type, source_table, target_table, cron_expression, priority, config) VALUES
  ('load_dim_time',     'Заповнення календарного виміру',          'full_load',   NULL,             'dwh_dim_time',          '0 3 * * *',    1, '{}'),
  ('load_dim_clients',  'Завантаження виміру клієнтів (SCD2)',     'incremental', 'clients',        'dwh_dim_clients',       '*/15 * * * *', 1, '{}'),
  ('load_dim_services', 'Завантаження виміру послуг (SCD2)',       'incremental', 'services',       'dwh_dim_services',      '*/15 * * * *', 1, '{}'),
  ('load_dim_staff',    'Завантаження виміру майстрів (SCD2)',     'incremental', 'masters',        'dwh_dim_staff',         '*/15 * * * *', 1, '{}'),
  ('load_dim_products', 'Завантаження виміру товарів (SCD2)',      'incremental', 'product_variants','dwh_dim_products',     '*/15 * * * *', 1, '{}'),
  ('load_fact_visits',  'Завантаження фактів візитів (CDC)',       'incremental', 'appointments',   'dwh_fact_visits_v2',    '*/15 * * * *', 5, '{}'),
  ('load_fact_sales',   'Завантаження фактів продажів (CDC)',      'incremental', 'order_items',    'dwh_fact_sales',        '*/15 * * * *', 5, '{}'),
  ('load_fact_payments','Завантаження фактів платежів (CDC)',      'incremental', 'cash_operations','dwh_fact_payments',     '*/15 * * * *', 5, '{}'),
  ('load_fact_payroll', 'Завантаження фактів зарплат майстрів',    'incremental', 'payroll_records','dwh_fact_staff_payroll','0 4 * * *',    5, '{}')
ON CONFLICT (name) DO NOTHING;

-- ════════════════════ 180.7 СІД ДЖЕРЕЛ ДАНИХ ════════════════════
INSERT INTO dwh_data_sources (name, source_type, connection_config, health_status, tables_available, is_active) VALUES
  ('main_oltp', 'postgresql', '{"host":"localhost","db":"app","schema":"public"}'::jsonb, 'unknown',
   ARRAY['appointments','clients','services','masters','orders','order_items','cash_operations','payroll_records','product_variants'], TRUE)
ON CONFLICT (name) DO NOTHING;

COMMIT;
