-- 152: SAL-03 Rooms & Cabinets — расширение модуля кабинетов.
-- Базовая таблица rooms (027) — single-salon, без tenant_id/RLS. Дочерние таблицы
-- следуют той же модели (integer rooms.id, без отдельного RLS-слоя). Доступ app_tenant
-- раздаётся ALTER DEFAULT PRIVILEGES при создании; GRANT-ы ниже — на всякий случай.
BEGIN;

-- ── 152.1 Расширение карточки помещения ──────────────────────────────────────
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_type               VARCHAR(30)  NOT NULL DEFAULT 'cabinet';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS branch_id               INTEGER;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor                   INTEGER      DEFAULT 1;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_number             VARCHAR(20);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area_sqm                DECIMAL(6,2);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS description             TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS internal_note           TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS photo_urls              JSONB        DEFAULT '[]'::jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS compatible_service_types JSONB       DEFAULT '[]'::jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status                  VARCHAR(20)  DEFAULT 'active';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_repair_date        DATE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS next_sanitization_date  DATE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_code_url             VARCHAR(500);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ  DEFAULT NOW();
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS deleted_at              TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_rooms_type   ON rooms (room_type);
CREATE INDEX IF NOT EXISTS ix_rooms_status ON rooms (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_rooms_branch ON rooms (branch_id) WHERE deleted_at IS NULL;

-- ── 152.2 Оборудование помещения ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_equipment (
  id                SERIAL       PRIMARY KEY,
  room_id           INTEGER      NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  equipment_type    VARCHAR(50)  NOT NULL,   -- chair|mirror|lamp|sterilizer|device|sink
  name              VARCHAR(200) NOT NULL,
  model             VARCHAR(200),
  serial_number     VARCHAR(100),
  installed_at      DATE,
  last_maintenance  DATE,
  next_maintenance  DATE,
  status            VARCHAR(20)  NOT NULL DEFAULT 'working' CHECK (status IN ('working','broken','maintenance')),
  linked_service_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_room_equipment_room ON room_equipment (room_id, status);
CREATE INDEX IF NOT EXISTS ix_room_equipment_maint ON room_equipment (next_maintenance) WHERE status = 'working';

-- ── 152.3 Расписание доступности ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_schedules (
  id               SERIAL      PRIMARY KEY,
  room_id          INTEGER     NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day_of_week      INTEGER     NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=пн … 6=вс
  open_time        TIME        NOT NULL,
  close_time       TIME        NOT NULL,
  break_start      TIME,
  break_end        TIME,
  cleanup_interval INTEGER     NOT NULL DEFAULT 0,   -- минуты уборки между клиентами
  is_day_off       BOOLEAN     NOT NULL DEFAULT FALSE,
  season           VARCHAR(20) NOT NULL DEFAULT 'default',
  valid_from       DATE        NOT NULL DEFAULT '2000-01-01',
  valid_until      DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (is_day_off OR open_time < close_time)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_room_schedules ON room_schedules (room_id, day_of_week, season, valid_from);
CREATE INDEX IF NOT EXISTS ix_room_schedules_room ON room_schedules (room_id, day_of_week);

-- ── 152.4 Блокировки помещения ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_blocks (
  id                    SERIAL       PRIMARY KEY,
  room_id               INTEGER      NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  block_type            VARCHAR(30)  NOT NULL CHECK (block_type IN ('repair','sanitization','training','inventory','other')),
  reason                VARCHAR(500) NOT NULL,
  blocked_from          TIMESTAMPTZ  NOT NULL,
  blocked_until         TIMESTAMPTZ  NOT NULL,
  blocked_by            INTEGER,     -- employees/masters id
  affected_appointments INTEGER      NOT NULL DEFAULT 0,
  auto_reschedule       BOOLEAN      NOT NULL DEFAULT FALSE,
  status                VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  completed_at          TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (blocked_from < blocked_until)
);
CREATE INDEX IF NOT EXISTS ix_room_blocks_room   ON room_blocks (room_id, status);
CREATE INDEX IF NOT EXISTS ix_room_blocks_active ON room_blocks (blocked_from, blocked_until) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON room_equipment, room_schedules, room_blocks TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE room_equipment_id_seq, room_schedules_id_seq, room_blocks_id_seq TO app_tenant;

COMMIT;
