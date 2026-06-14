-- ═══════════════════════════════════════════════════════
-- INF-01 — EVENT BUS (шина доменных событий)
-- Persistent outbox + журнал доменных событий. Модули публикуют
-- события (appointment.completed, sale.created, client.created…),
-- подписчики (уведомления, лояльность, аналитика) реагируют.
-- Таблица служит и журналом (аудит/отладка), и outbox для replay.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS domain_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID,
  event_type    TEXT NOT NULL,                 -- 'appointment.completed', 'sale.created' …
  entity_type   TEXT,                          -- 'appointment', 'sale', 'client' …
  entity_id     TEXT,
  actor         TEXT,                          -- кто/что инициировало (user label / 'system')
  payload       JSONB,
  status        TEXT NOT NULL DEFAULT 'emitted', -- emitted | handled | failed
  handler_count INTEGER NOT NULL DEFAULT 0,    -- сколько подписчиков обработали
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_domain_events_type    ON domain_events (event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_created ON domain_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_status  ON domain_events (status);
CREATE INDEX IF NOT EXISTS idx_domain_events_entity  ON domain_events (entity_type, entity_id);
