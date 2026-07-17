-- 273_fitness_module.sql (18.07.2026, Jarvis)
-- Вертикаль ФИТНЕС: групповые занятия, лист ожидания, чек-ин.
-- Членства НЕ дублируем — переиспользуется модуль абонементов (subscriptions, 057/175):
-- он уже умеет visits/time/minutes/combo, заморозку, кассу, идемпотентное списание.
-- Все таблицы tenant-изолированы (RLS-паттерн миграции 269).

CREATE TABLE IF NOT EXISTS fitness_class_types (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  name             TEXT NOT NULL,
  color            TEXT DEFAULT '#7c5cff',
  duration_min     INT  NOT NULL DEFAULT 60,
  default_capacity INT  NOT NULL DEFAULT 10,
  active           BOOLEAN NOT NULL DEFAULT true,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fct_tenant ON fitness_class_types(tenant_id, active);

CREATE TABLE IF NOT EXISTS fitness_classes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  class_type_id BIGINT NOT NULL,
  trainer_id    BIGINT,            -- masters.id (тренер), без FK по стилю кодовой базы
  room_id       BIGINT,            -- rooms.id (зал)
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  capacity      INT NOT NULL DEFAULT 10,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','done')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fcl_tenant_time ON fitness_classes(tenant_id, starts_at);

CREATE TABLE IF NOT EXISTS fitness_class_bookings (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id(),
  class_id        BIGINT NOT NULL,
  client_id       BIGINT NOT NULL,
  subscription_id BIGINT,          -- абонемент, которым планируют платить (опционально)
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked','attended','cancelled','waitlist','noshow')),
  waitlist_pos    INT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- один клиент — одна живая запись на занятие (отменённые не мешают записаться снова)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcb_class_client_live
  ON fitness_class_bookings(class_id, client_id)
  WHERE status IN ('booked','attended','waitlist');
CREATE INDEX IF NOT EXISTS idx_fcb_tenant_class ON fitness_class_bookings(tenant_id, class_id, status);

CREATE TABLE IF NOT EXISTS fitness_class_templates (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  day_of_week   INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=понедельник
  time_start    TIME NOT NULL,
  class_type_id BIGINT NOT NULL,
  trainer_id    BIGINT,
  room_id       BIGINT,
  capacity      INT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fctpl_tenant ON fitness_class_templates(tenant_id, active);

CREATE TABLE IF NOT EXISTS fitness_checkins (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id(),
  client_id        BIGINT NOT NULL,
  subscription_id  BIGINT,
  at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('qr','manual','class')),
  class_booking_id BIGINT,
  denied           BOOLEAN NOT NULL DEFAULT false,
  deny_reason      TEXT,             -- expired | frozen | no_visits | no_membership
  performed_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_fchk_tenant_at ON fitness_checkins(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_fchk_client ON fitness_checkins(tenant_id, client_id, at DESC);

-- RLS как у остальных tenant-таблиц
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fitness_class_types','fitness_classes','fitness_class_bookings',
                           'fitness_class_templates','fitness_checkins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;
