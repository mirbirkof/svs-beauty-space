-- 277: вертикаль WELLNESS (Phase B, 18.07.2026). ТЗ: tz_modules/v2/vertical-03-wellness.md
-- Велнес = салонное ядро + комнаты в расписании + couples-брони + processing time.
-- Салон (beauty) не задет: новые проверки активируются только данными, которых у него нет.

-- 1) Вертикаль в CHECK (идемпотентно: DROP+ADD в одном ALTER-паттерне)
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_business_type_chk;
ALTER TABLE tenants ADD CONSTRAINT tenants_business_type_chk
  CHECK (business_type IN ('beauty', 'fitness', 'dental', 'wellness'));
ALTER TABLE pending_signups DROP CONSTRAINT IF EXISTS pending_signups_business_type_chk;

-- 2) Требования услуги к комнате (services не трогаем — отдельная таблица, PK=service_id)
CREATE TABLE IF NOT EXISTS service_room_requirements (
  service_id BIGINT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id(),
  requires_room BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_srr_tenant ON service_room_requirements(tenant_id);

-- 3) Парные (couples) брони: группа + состав. Отмена одной записи не рвёт группу.
CREATE TABLE IF NOT EXISTS booking_groups (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id(),
  kind TEXT NOT NULL DEFAULT 'couples' CHECK (kind IN ('couples', 'group')),
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS booking_group_items (
  group_id BIGINT NOT NULL REFERENCES booking_groups(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id(),
  PRIMARY KEY (group_id, appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_bgi_appt ON booking_group_items(appointment_id);

-- 4) Фичи вертикали в тарифы (паттерн 272: явные строки, БЕЗ fail-open).
-- Базовые операции — всем планам (иначе wellness на free мёртв): wellness.rooms, wellness.couples.
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, fk.key, TRUE
  FROM saas_plans_v2 p
  CROSS JOIN (VALUES ('wellness.rooms'), ('wellness.couples')) AS fk(key)
 WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro', 'enterprise', 'solo_max')
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = fk.key);
