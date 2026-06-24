-- 161: AI-07 Recommendations — рушій персональних рекомендацій.
-- Прагматична single-salon версія: без важкого ML (ALS/neural), а евристичний
-- гібрид на РЕАЛЬНИХ даних — item-based CF (co-occurrence послуг з appointments)
-- + content-based (збіг категорій) + популярність (fallback/cold start).
-- Реєстр моделей, лог рекомендацій, feedback, feature store. Integer SERIAL,
-- single-salon (як services/clients/appointments) — без tenant/RLS.
BEGIN;

-- ── 161.1 Реєстр моделей ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_recommendation_models (
  id                 SERIAL       PRIMARY KEY,
  name               VARCHAR(100) NOT NULL,
  type               VARCHAR(30)  NOT NULL DEFAULT 'hybrid',   -- collaborative_item|content_based|hybrid|popularity
  algorithm          VARCHAR(50)  NOT NULL DEFAULT 'cooccurrence_cosine',
  hyperparameters    JSONB        NOT NULL DEFAULT '{}',       -- {w_cf:0.6, w_cb:0.4, exploration:0.1}
  metrics            JSONB,
  training_data_size INTEGER,
  training_duration_s INTEGER,
  model_artifact_url VARCHAR(500),
  status             VARCHAR(20)  NOT NULL DEFAULT 'ready',    -- training|ready|active|archived
  is_active          BOOLEAN      NOT NULL DEFAULT FALSE,
  ab_weight          NUMERIC(3,2) NOT NULL DEFAULT 0,
  trained_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_models_status ON ai_recommendation_models (status, is_active);

-- ── 161.2 Згенеровані рекомендації ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id                 SERIAL       PRIMARY KEY,
  client_id          INTEGER      REFERENCES clients(id) ON DELETE CASCADE,
  item_type          VARCHAR(20)  NOT NULL,           -- service|product|master|time_slot
  item_id            INTEGER      NOT NULL,
  model_id           INTEGER      REFERENCES ai_recommendation_models(id),
  score              NUMERIC(6,4) NOT NULL DEFAULT 0,
  cf_score           NUMERIC(6,4),
  cb_score           NUMERIC(6,4),
  rank               INTEGER      NOT NULL DEFAULT 0,
  reason             VARCHAR(50)  NOT NULL DEFAULT 'popular',  -- similar_clients|similar_items|profile_match|popular|trending|repeat|exploration
  explanation        TEXT,
  context            VARCHAR(30)  NOT NULL DEFAULT 'catalog',  -- catalog|booking|cabinet|master_card|notification|checkout
  status             VARCHAR(20)  NOT NULL DEFAULT 'generated',-- generated|shown|clicked|converted|dismissed
  shown_at           TIMESTAMPTZ,
  clicked_at         TIMESTAMPTZ,
  converted_at       TIMESTAMPTZ,
  conversion_revenue NUMERIC(10,2),
  expires_at         TIMESTAMPTZ  DEFAULT (now() + INTERVAL '7 days'),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_client ON ai_recommendations (client_id, context, status, created_at);
CREATE INDEX IF NOT EXISTS idx_rec_model ON ai_recommendations (model_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rec_item ON ai_recommendations (item_type, item_id, created_at);

-- ── 161.3 Feedback ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_recommendation_feedback (
  id                SERIAL       PRIMARY KEY,
  recommendation_id INTEGER      REFERENCES ai_recommendations(id) ON DELETE CASCADE,
  client_id         INTEGER,
  feedback_type     VARCHAR(20)  NOT NULL,    -- impression|click|book|purchase|dismiss|like|dislike
  context_data      JSONB        NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_fb_client ON ai_recommendation_feedback (client_id, feedback_type, created_at);
CREATE INDEX IF NOT EXISTS idx_rec_fb_rec ON ai_recommendation_feedback (recommendation_id);

-- ── 161.4 Feature store ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_feature_store (
  id           SERIAL       PRIMARY KEY,
  entity_type  VARCHAR(20)  NOT NULL,         -- client|service|product|master
  entity_id    INTEGER      NOT NULL,
  features     JSONB        NOT NULL DEFAULT '{}',
  computed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  valid_until  TIMESTAMPTZ  DEFAULT (now() + INTERVAL '24 hours'),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_fs_entity ON ai_feature_store (entity_type, entity_id);

-- ── 161.5 Сід базової евристичної моделі ─────────────────────────────────────
INSERT INTO ai_recommendation_models (name, type, algorithm, hyperparameters, status, is_active, ab_weight, trained_at)
SELECT 'hybrid_heuristic_v1', 'hybrid', 'cooccurrence_cosine',
       '{"w_cf":0.6,"w_cb":0.4,"exploration":0.1}'::jsonb, 'active', TRUE, 1.0, now()
WHERE NOT EXISTS (SELECT 1 FROM ai_recommendation_models WHERE is_active=TRUE);

COMMIT;
