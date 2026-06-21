-- COM-10 — Instagram-канал (Meta Graph API).
-- Канал уже поддержан схемой omni_channels (config JSONB). Здесь — только
-- индекс для кросс-тенантной маршрутизации вебхука по ig_user_id.
--
-- config салона для channel='instagram':
--   { ig_user_id, page_id, page_token, auto_agent, auto_book, agent_id }
-- Вебхук Meta приходит на один URL → салон ищется по config->>'ig_user_id'.
-- Индекс частичный (только instagram), чтобы поиск был O(log n) на всю платформу.

CREATE INDEX IF NOT EXISTS idx_omni_channels_ig_user
  ON omni_channels ((config->>'ig_user_id'))
  WHERE channel = 'instagram';
