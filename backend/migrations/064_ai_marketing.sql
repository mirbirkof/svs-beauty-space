-- 064: AI-03 AI Marketing — генерация маркетингового контента (рассылки, посты, ответы на отзывы),
-- brand voice (тон бренда), контент-план, A/B варианты. LLM через lib/llm.js (Gemini/OpenRouter/Groq).
-- Адаптировано под реальную схему: integer branch_id/created_by, BIGSERIAL id, RLS по tenant_id.
BEGIN;

-- 064.1 Настройки тона бренда (brand voice)
CREATE TABLE IF NOT EXISTS ai_brand_voice (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id       INTEGER,
  name            TEXT NOT NULL,
  tone            TEXT NOT NULL DEFAULT 'friendly',   -- friendly | professional | premium | casual
  description     TEXT,
  preferred_words TEXT[] NOT NULL DEFAULT '{}',
  banned_words    TEXT[] NOT NULL DEFAULT '{}',
  example_texts   TEXT[] NOT NULL DEFAULT '{}',
  emoji_usage     TEXT NOT NULL DEFAULT 'moderate',   -- none | minimal | moderate | heavy
  formality       TEXT NOT NULL DEFAULT 'neutral',    -- formal | neutral | informal
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_brand_voice ON ai_brand_voice (tenant_id, COALESCE(branch_id,-1), name);

-- 064.2 Генерации контента (+ A/B группировка, perf-метрики)
CREATE TABLE IF NOT EXISTS ai_content_generations (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id      INTEGER,
  type           TEXT NOT NULL,            -- email | sms | telegram | instagram | review_reply | subject_line
  purpose        TEXT NOT NULL DEFAULT 'promo', -- promo | info | greeting | reminder | winback | review_reply
  prompt         TEXT,
  generated_text TEXT NOT NULL,
  variables      JSONB NOT NULL DEFAULT '{}'::jsonb,
  language       TEXT NOT NULL DEFAULT 'uk',
  brand_voice_id BIGINT REFERENCES ai_brand_voice(id) ON DELETE SET NULL,
  ab_variant     TEXT,                      -- A | B | C ...
  ab_group_id    UUID,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | approved | sent | archived
  performance    JSONB NOT NULL DEFAULT '{}'::jsonb,
  campaign_id    BIGINT,
  created_by     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_aigen_type   ON ai_content_generations (type, status);
CREATE INDEX IF NOT EXISTS ix_aigen_abgrp  ON ai_content_generations (ab_group_id);
CREATE INDEX IF NOT EXISTS ix_aigen_created ON ai_content_generations (created_at DESC);

-- 064.3 Шаблоны промптов
CREATE TABLE IF NOT EXISTS ai_content_templates (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id        INTEGER,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  purpose          TEXT NOT NULL DEFAULT 'promo',
  prompt_template  TEXT NOT NULL,
  variables_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_voice_id   BIGINT REFERENCES ai_brand_voice(id) ON DELETE SET NULL,
  example_output   TEXT,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  avg_performance  JSONB NOT NULL DEFAULT '{}'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_aitpl_type ON ai_content_templates (type, active);

-- 064.4 Контент-планы
CREATE TABLE IF NOT EXISTS ai_content_plans (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  branch_id    INTEGER,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by TEXT NOT NULL DEFAULT 'ai',  -- ai | manual
  approved_by  INTEGER,
  approved_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | approved | active | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_aiplan_period ON ai_content_plans (period_start, period_end);

-- RLS: изоляция по тенанту
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_brand_voice','ai_content_generations','ai_content_templates','ai_content_plans'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_brand_voice, ai_content_generations, ai_content_templates, ai_content_plans TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE ai_brand_voice_id_seq, ai_content_generations_id_seq, ai_content_templates_id_seq, ai_content_plans_id_seq TO app_tenant;

COMMIT;
