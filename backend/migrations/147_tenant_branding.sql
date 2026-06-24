-- 147: SAS-08 Branding — brand asset library, brand guidelines, template engine.
-- Доповнює SAS-02 (white_label_configs): там CSS-теми, тут — контентні ассети
-- і brand book (логотипи у форматах, шрифти, ілюстрації, email/SMS-шаблони тощо).
-- Таблиці: brand_assets, brand_guidelines, brand_templates.
-- RLS: tenant_isolation (паттерн як у 105_master_services.sql).
-- Грант: app_tenant. Ідемпотентно.
BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. brand_assets — бібліотека брендових ассетів з версіонуванням
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_assets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  asset_type        VARCHAR(30) NOT NULL,
  -- logo_primary | logo_alt | logo_mono | logo_reversed
  -- icon | favicon | font | photo | illustration | watermark
  name              VARCHAR(255) NOT NULL,
  original_url      VARCHAR(500) NOT NULL,
  thumbnail_url     VARCHAR(500),
  small_url         VARCHAR(500),
  medium_url        VARCHAR(500),
  large_url         VARCHAR(500),
  mime_type         VARCHAR(50)  NOT NULL,
  file_size_bytes   INT          NOT NULL DEFAULT 0,
  width             INT,
  height            INT,
  version           INT          NOT NULL DEFAULT 1,
  tags              VARCHAR(50)[] NOT NULL DEFAULT '{}',
  metadata          JSONB        NOT NULL DEFAULT '{}',
  -- {"colors":["#8B5CF6","#EC4899"],"format":"svg","license":"MIT"}
  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_assets_asset_type_check CHECK (
    asset_type IN ('logo_primary','logo_alt','logo_mono','logo_reversed',
                   'icon','favicon','font','photo','illustration','watermark')
  )
);
CREATE INDEX IF NOT EXISTS idx_ba_tenant ON brand_assets (tenant_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_ba_tags   ON brand_assets USING GIN (tags);

-- ────────────────────────────────────────────────────────────
-- 2. brand_guidelines — цифровий brand book тенанта (1 рядок на тенанта)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_guidelines (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  color_palette       JSONB        NOT NULL DEFAULT '{}',
  -- {"primary":"#8B5CF6","secondary":"#EC4899","accent":"#F59E0B",
  --  "neutral":"#6B7280","error":"#EF4444","success":"#10B981","warning":"#F59E0B"}
  typography          JSONB        NOT NULL DEFAULT '{}',
  -- {"heading":{"family":"Inter","weight":700},"body":{"family":"Inter","weight":400,"lineHeight":1.6}}
  tone_of_voice       VARCHAR(20)  NOT NULL DEFAULT 'friendly',
  -- formal | friendly | playful | professional
  logo_rules          JSONB        NOT NULL DEFAULT '{}',
  -- {"minPadding":"16px","forbiddenBackgrounds":["red","orange"]}
  custom_guidelines   TEXT,
  guideline_pdf_url   VARCHAR(500),
  style_guide_slug    VARCHAR(100) UNIQUE,
  -- публічне посилання: /brand/:slug
  consistency_score   SMALLINT     CHECK (consistency_score BETWEEN 0 AND 100),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id),
  CONSTRAINT brand_guidelines_tone_check CHECK (
    tone_of_voice IN ('formal','friendly','playful','professional')
  )
);
CREATE INDEX IF NOT EXISTS idx_bg_tenant ON brand_guidelines (tenant_id);

-- ────────────────────────────────────────────────────────────
-- 3. brand_templates — email/SMS/push/marketing шаблони
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_templates (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = глобальний шаблон платформи (superadmin)
  template_type   VARCHAR(30)   NOT NULL,
  -- email | sms | push | business_card | flyer | social_post | certificate | gift_card | receipt
  name            VARCHAR(100)  NOT NULL,
  slug            VARCHAR(100)  NOT NULL,
  subject         VARCHAR(255),
  -- для email/push
  body_html       TEXT,
  -- для email (MJML compiled)
  body_mjml       TEXT,
  -- вихідний MJML
  body_text       TEXT,
  -- для SMS або plain text fallback
  variables       JSONB         NOT NULL DEFAULT '[]',
  -- [{"key":"client.name","label":"Ім'я клієнта","required":true}]
  language        CHAR(2)       NOT NULL DEFAULT 'uk',
  -- uk | ru | en
  category        VARCHAR(30),
  -- appointment | marketing | loyalty | system
  design_config   JSONB         NOT NULL DEFAULT '{}',
  -- для візуальних шаблонів: розміри, шари, позиції
  thumbnail_url   VARCHAR(500),
  is_default      BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  version         INT           NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_templates_type_check CHECK (
    template_type IN ('email','sms','push','business_card','flyer','social_post',
                      'certificate','gift_card','receipt')
  ),
  CONSTRAINT brand_templates_lang_check CHECK (language IN ('uk','ru','en')),
  UNIQUE (tenant_id, slug, language)
);
CREATE INDEX IF NOT EXISTS idx_bt_tenant ON brand_templates (tenant_id, template_type);
CREATE INDEX IF NOT EXISTS idx_bt_type   ON brand_templates (template_type, is_active);

-- ────────────────────────────────────────────────────────────
-- RLS (паттерн 105_master_services.sql)
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['brand_assets', 'brand_guidelines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))$p$, t);
  END LOOP;
END $$;

-- brand_templates: NULL tenant_id = глобальні шаблони (платформа). RLS по tenant або IS NULL.
ALTER TABLE brand_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON brand_templates;
CREATE POLICY tenant_isolation ON brand_templates
  USING (
    tenant_id IS NULL
    OR tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id)
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id)
  );

-- ────────────────────────────────────────────────────────────
-- GRANTs
-- ────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON brand_assets, brand_guidelines, brand_templates TO app_tenant;

COMMIT;
