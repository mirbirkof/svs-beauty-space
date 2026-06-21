-- COM-10 доповнення — Instagram Content (публікації + insights).
-- Базовий канал (повідомлення/коментарі/AI-агент) уже є: omni_channels.config
-- (channel='instagram': ig_user_id, page_id, page_token, ...). Тут — планувальник
-- публікацій. Insights/публікація «зараз» працюють наживо без зберігання.
-- Токени НЕ дублюються: беруться з omni_channels. ID — SERIAL. RLS+FORCE.

CREATE TABLE IF NOT EXISTS instagram_scheduled_posts (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id(),
  media_type    VARCHAR(16) NOT NULL DEFAULT 'IMAGE',  -- IMAGE/CAROUSEL/REELS
  image_url     TEXT,
  video_url     TEXT,
  children      JSONB,                                  -- масив URL для CAROUSEL
  caption       TEXT,
  product_tags  JSONB,                                  -- опц. теги товарів (потрібен схвалений каталог Meta)
  scheduled_at  TIMESTAMPTZ,                            -- NULL = опубліковано одразу
  status        VARCHAR(16) NOT NULL DEFAULT 'scheduled', -- scheduled/publishing/published/failed/canceled
  ig_media_id   VARCHAR(64),
  permalink     TEXT,
  error         TEXT,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ig_sched_due
  ON instagram_scheduled_posts (tenant_id, scheduled_at)
  WHERE status = 'scheduled';

-- RLS (той самий шаблон, що 132/133/134)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['instagram_scheduled_posts']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))',
      t
    );
  END LOOP;
END $$;
