-- 278: Phase C (18.07.2026) — доработки вертикалей из исследования рынка.
-- C1 dental: журнал recall-действий («ни один пациент не потерялся» — слабость даже
--    Open Dental; сама очередь ВЫЧИСЛЯЕТСЯ из существующих данных, тут только лог действий).
-- C3 fitness: спот-бронирование (место/reformer — стандарт пилатеса/cycling).

-- C1: лог действий по recall-очереди (кто связался/отложил/закрыл)
CREATE TABLE IF NOT EXISTS dental_recall_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id(),
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('open_plan', 'recall_due', 'noshow')),
  action TEXT NOT NULL CHECK (action IN ('contacted', 'booked', 'snoozed', 'dismissed')),
  comment TEXT,
  snooze_until DATE,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drl_client ON dental_recall_log(tenant_id, client_id, created_at DESC);

-- Фича recall — базовая ценность ретеншна, всем планам (паттерн 272)
INSERT INTO plan_features (plan_id, feature_key, enabled)
SELECT p.id, 'dental.recall', TRUE
  FROM saas_plans_v2 p
 WHERE p.slug IN ('free', 'starter', 'professional', 'solo_pro', 'enterprise', 'solo_max')
   AND NOT EXISTS (SELECT 1 FROM plan_features x WHERE x.plan_id = p.id AND x.feature_key = 'dental.recall');

-- C3: номер места в групповом занятии (NULL = без места, как раньше).
-- Уникальность живого места в занятии — частичный индекс (cancelled/waitlist место не держат).
ALTER TABLE fitness_class_bookings ADD COLUMN IF NOT EXISTS spot_number INT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcb_class_spot
  ON fitness_class_bookings(tenant_id, class_id, spot_number)
  WHERE spot_number IS NOT NULL AND status IN ('booked', 'attended');
