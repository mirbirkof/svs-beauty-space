-- 113: INF-04 Monitoring. Прагматичная наблюдаемость для одно-/мульти-салонной
-- инсталляции на Render (без Prometheus/Loki/Jaeger/Grafana — это enterprise-стек,
-- избыточный для текущего масштаба). Что реально работает:
--   • health_checks  — периодические проверки сервисов (HTTP) и БД (db ping);
--   • uptime_records — история доступности для расчёта uptime/SLA (ретеншн 90 дней);
--   • alert_rules    — пороговые правила по встроенным метрикам (НЕ PromQL):
--                      service_down / db_latency_ms / consecutive_failures / error_rate;
--   • alert_history  — срабатывания (firing/resolved), ack, silence, авто-инцидент;
--   • sla_configs    — цель uptime по набору сервисов + отчёт за период.
-- Платформенные таблицы (как billing/saas — БЕЗ per-tenant RLS): мониторинг общий,
-- суперадмин/владелец видит всю платформу. id = BIGSERIAL для простых джойнов.
BEGIN;

-- Проверки здоровья сервисов. check_type: http | db.
CREATE TABLE IF NOT EXISTS health_checks (
  id                   BIGSERIAL PRIMARY KEY,
  service_name         TEXT NOT NULL,
  check_type           TEXT NOT NULL DEFAULT 'http',     -- http | db
  endpoint             TEXT NOT NULL,                     -- URL (http) или 'self' (db)
  interval_sec         INTEGER NOT NULL DEFAULT 60,
  timeout_ms           INTEGER NOT NULL DEFAULT 8000,
  expected_status      INTEGER DEFAULT 200,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_status          TEXT NOT NULL DEFAULT 'unknown',   -- up | down | degraded | unknown
  last_response_ms     INTEGER,
  last_checked_at      TIMESTAMPTZ,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_name, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_hc_status ON health_checks(last_status);

-- История проверок (для uptime/SLA). Прунинг старше 90 дней — в чекере.
CREATE TABLE IF NOT EXISTS uptime_records (
  id               BIGSERIAL PRIMARY KEY,
  health_check_id  BIGINT NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE,
  status           TEXT NOT NULL,                         -- up | down | degraded
  response_time_ms INTEGER,
  error_message    TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_up_check_date ON uptime_records(health_check_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_up_status ON uptime_records(status, checked_at);

-- Пороговые правила алертов по встроенным метрикам.
CREATE TABLE IF NOT EXISTS alert_rules (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  metric_key       TEXT NOT NULL,                         -- service_down|db_latency_ms|consecutive_failures|error_rate|uptime_24h
  service_name     TEXT,                                  -- NULL = любой/глобально
  comparator       TEXT NOT NULL DEFAULT '>',             -- > | >= | < | <= | ==
  threshold        NUMERIC(20,4) NOT NULL DEFAULT 0,
  for_consecutive  INTEGER NOT NULL DEFAULT 1,            -- сколько проверок подряд держится до firing
  severity         TEXT NOT NULL DEFAULT 'warning',       -- info|warning|critical|emergency
  notify_channels  TEXT[] NOT NULL DEFAULT '{}',          -- telegram|email (best-effort)
  auto_incident    BOOLEAN NOT NULL DEFAULT FALSE,        -- создать инцидент MGT-04 при firing
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  breach_streak    INTEGER NOT NULL DEFAULT 0,            -- текущая серия нарушений (служебное)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ar_active ON alert_rules(is_active) WHERE is_active = TRUE;

-- История срабатываний алертов.
CREATE TABLE IF NOT EXISTS alert_history (
  id               BIGSERIAL PRIMARY KEY,
  rule_id          BIGINT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'firing',        -- firing | resolved
  severity         TEXT NOT NULL,
  service_name     TEXT,
  value            NUMERIC(20,4),
  message          TEXT,
  fired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  acknowledged_by  INTEGER,
  acknowledged_at  TIMESTAMPTZ,
  silenced_until   TIMESTAMPTZ,
  incident_id      BIGINT,                                -- → incidents.id (MGT-04), best-effort
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_ah_status ON alert_history(status);
CREATE INDEX IF NOT EXISTS idx_ah_rule ON alert_history(rule_id, fired_at DESC);

-- Конфигурации SLA.
CREATE TABLE IF NOT EXISTS sla_configs (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  target_uptime      NUMERIC(6,4) NOT NULL DEFAULT 99.9000,  -- проценты, 99.9
  measurement_window TEXT NOT NULL DEFAULT 'monthly',        -- monthly|quarterly|yearly
  services           TEXT[] NOT NULL DEFAULT '{}',           -- service_name[]
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Базовые проверки: сам shop-api, booking-api и БД.
INSERT INTO health_checks (service_name, check_type, endpoint, interval_sec, expected_status)
VALUES
  ('shop-api',    'http', 'https://svs-shop-api.onrender.com/health',        60, 200),
  ('booking-api', 'http', 'https://svs-booking-api.onrender.com/api/health', 60, 200),
  ('database',    'db',   'self',                                            60, 200)
ON CONFLICT (service_name, endpoint) DO NOTHING;

-- Базовое правило: сервис лежит → critical + авто-инцидент после 3 проверок подряд.
INSERT INTO alert_rules (name, metric_key, comparator, threshold, for_consecutive, severity, notify_channels, auto_incident)
SELECT 'Сервіс недоступний', 'service_down', '==', 1, 3, 'critical', ARRAY['telegram'], TRUE
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE metric_key='service_down' AND service_name IS NULL);

-- Платформенные таблицы — доступ роли app_tenant без RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON health_checks, uptime_records, alert_rules, alert_history, sla_configs TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE health_checks_id_seq, uptime_records_id_seq, alert_rules_id_seq,
  alert_history_id_seq, sla_configs_id_seq TO app_tenant;

COMMIT;
