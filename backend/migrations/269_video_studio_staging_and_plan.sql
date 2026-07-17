-- 269_video_studio_staging_and_plan.sql (17.07.2026, спец Босса)
-- 1) ai_video_staging — клипы, загруженные в студию ЗАРАНЕЕ (переживают обновление
--    страницы; можно удалить лишний). Привязка к пункту контент-плана опциональна.
-- 2) ai_content_plan_items — контент-план: идея → сценарий → задача админу
--    «что снять» → загруженные клипы → авто-монтаж по сценарию.

CREATE TABLE IF NOT EXISTS ai_video_staging (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  plan_item_id BIGINT,
  file_name    TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  duration_sec NUMERIC,
  sort_order   INT NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_staging_tenant ON ai_video_staging(tenant_id, plan_item_id);

CREATE TABLE IF NOT EXISTS ai_content_plan_items (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  publish_date DATE,
  idea         TEXT NOT NULL,
  scenario     JSONB NOT NULL DEFAULT '{}'::jsonb, -- {scenes:[{prompt,narration,shootHint}],caption,hashtags,voiceText,musicMood,trendSoundAdvice}
  shoot_tasks  JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["Зніми, як клієнтка сідає в крісло (3-5с)", ...]
  status       TEXT NOT NULL DEFAULT 'plan',       -- plan|shooting|ready_to_render|rendered
  video_id     BIGINT,                             -- готовый ролик в ai_video_library
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_plan_tenant ON ai_content_plan_items(tenant_id, publish_date);

-- RLS как у остальных tenant-таблиц
ALTER TABLE ai_video_staging ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_video_staging;
CREATE POLICY tenant_isolation ON ai_video_staging
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

ALTER TABLE ai_content_plan_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_content_plan_items;
CREATE POLICY tenant_isolation ON ai_content_plan_items
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- 3) Retention (Босс 17.07): готовый ролик хранится 3 дня → файл удаляется,
--    запись остаётся для статистики с archived_at (место не занимает).
ALTER TABLE ai_video_library ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
