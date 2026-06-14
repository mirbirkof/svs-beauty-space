-- 041: MKT-03 Маркетинговые кампании (рассылки на сегменты).
CREATE TABLE IF NOT EXISTS campaigns (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID,
  name         TEXT NOT NULL,
  segment_id   INTEGER REFERENCES segments(id) ON DELETE SET NULL,
  preset_key   TEXT,                        -- альтернатива segment_id
  channel      TEXT DEFAULT 'telegram',     -- предпочтительный канал (или any)
  template_key TEXT,                         -- шаблон из notification_templates
  body         TEXT,                         -- или прямой текст (если без шаблона)
  vars         JSONB DEFAULT '{}'::jsonb,    -- доп. переменные
  status       TEXT NOT NULL DEFAULT 'draft',-- draft|scheduled|running|done|paused|cancelled
  scheduled_at TIMESTAMPTZ,
  audience_size INTEGER,
  enqueued     INTEGER DEFAULT 0,
  skipped      INTEGER DEFAULT 0,
  launched_at  TIMESTAMPTZ,
  done_at      TIMESTAMPTZ,
  created_by   INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
