-- 109: SAS-02 White Label + SAS-08 Branding. Кастомизация внешнего вида под тенанта:
-- логотип, цвета, шрифты, название приложения, тема (CSS-переменные), пресеты,
-- preview/publish/rollback с историей, powered-by по тарифу. Без ключей/CDN —
-- логотип хранится как URL, CSS генерируется движком тем на лету.
BEGIN;

-- Конфиг white label на тенанта (одна строка на тенанта).
CREATE TABLE IF NOT EXISTS white_label_configs (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() UNIQUE,
  app_name            TEXT NOT NULL DEFAULT 'SVS CRM',
  logo_url            TEXT,
  logo_dark_url       TEXT,
  favicon_url         TEXT,
  email_from_name     TEXT,
  email_from_address  TEXT,
  email_reply_to      TEXT,
  telegram_bot_name   TEXT,
  telegram_bot_avatar TEXT,
  show_powered_by     BOOLEAN NOT NULL DEFAULT TRUE,
  custom_copyright    TEXT,
  theme_preset_slug   TEXT,                          -- активный пресет (из theme_presets.slug)
  custom_css          TEXT,
  theme_variables     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- опубликованная light-тема
  dark_mode_variables JSONB DEFAULT '{}'::jsonb,
  navigation_config   JSONB DEFAULT '{}'::jsonb,      -- {hiddenModules:[], customOrder:[]}
  preview_variables   JSONB,                          -- черновик до публикации (sandbox)
  published_at        TIMESTAMPTZ,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Библиотека пресетов тем — глобальная (как saas_plans/feature_flags, без tenant).
CREATE TABLE IF NOT EXISTS theme_presets (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  description     TEXT,
  thumbnail_url   TEXT,
  variables       JSONB NOT NULL,
  dark_variables  JSONB,
  category        TEXT NOT NULL DEFAULT 'general',  -- general|luxury|minimal|nature|urban|medical|spa
  is_premium      BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_theme_presets_cat ON theme_presets(category, sort_order);

-- История версий темы для rollback (до 10 последних на тенанта).
CREATE TABLE IF NOT EXISTS white_label_history (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id(),
  version            INTEGER NOT NULL,
  variables_snapshot JSONB NOT NULL,
  config_snapshot    JSONB NOT NULL,
  changed_by         INTEGER,
  change_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, version)
);
CREATE INDEX IF NOT EXISTS idx_wlh_tenant_ver ON white_label_history(tenant_id, version DESC);

-- RLS (паттерн миграции 107) — только для tenant-таблиц. theme_presets глобальная.
ALTER TABLE white_label_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE white_label_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON white_label_configs;
DROP POLICY IF EXISTS tenant_isolation ON white_label_history;
CREATE POLICY tenant_isolation ON white_label_configs
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
CREATE POLICY tenant_isolation ON white_label_history
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON white_label_configs, white_label_history TO app_tenant;
GRANT SELECT ON theme_presets TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE white_label_configs_id_seq, white_label_history_id_seq, theme_presets_id_seq TO app_tenant;

-- Стартовая библиотека пресетов (8 тем).
INSERT INTO theme_presets (name, slug, description, category, sort_order, variables, dark_variables) VALUES
  ('Мінімал',      'minimal',     'Чистий світлий мінімалізм',        'minimal', 1,
    '{"colorPrimary":"#111827","colorSecondary":"#6B7280","colorAccent":"#3B82F6","fontHeading":"Inter","fontBody":"Inter","borderRadius":"8px"}'::jsonb,
    '{"colorPrimary":"#F9FAFB","colorSecondary":"#9CA3AF","colorAccent":"#60A5FA","colorBg":"#0B0F19"}'::jsonb),
  ('Розкіш Золото','luxury-gold', 'Преміальна чорно-золота гама',      'luxury',  2,
    '{"colorPrimary":"#1A1A1A","colorSecondary":"#B8860B","colorAccent":"#D4AF37","fontHeading":"Playfair Display","fontBody":"Inter","borderRadius":"4px"}'::jsonb,
    '{"colorPrimary":"#D4AF37","colorSecondary":"#9A7B0A","colorAccent":"#F0CE6B","colorBg":"#0A0A0A"}'::jsonb),
  ('Природа',      'nature-green','Спокійна зелена природа',           'nature',  3,
    '{"colorPrimary":"#14532D","colorSecondary":"#4D7C0F","colorAccent":"#65A30D","fontHeading":"Inter","fontBody":"Inter","borderRadius":"12px"}'::jsonb,
    NULL),
  ('Урбан Дарк',   'urban-dark',  'Сучасна темна тема',                'urban',   4,
    '{"colorPrimary":"#E5E7EB","colorSecondary":"#9CA3AF","colorAccent":"#8B5CF6","fontHeading":"Inter","fontBody":"Inter","borderRadius":"10px","colorBg":"#111827"}'::jsonb,
    '{"colorPrimary":"#F3F4F6","colorSecondary":"#9CA3AF","colorAccent":"#A78BFA","colorBg":"#030712"}'::jsonb),
  ('Медичний',     'medical-blue','Стерильний медичний синій',         'medical', 5,
    '{"colorPrimary":"#0C4A6E","colorSecondary":"#0369A1","colorAccent":"#0EA5E9","fontHeading":"Inter","fontBody":"Inter","borderRadius":"6px"}'::jsonb,
    NULL),
  ('Спа Спокій',   'spa-calm',    'Ніжні пастельні відтінки спа',      'spa',     6,
    '{"colorPrimary":"#9D174D","colorSecondary":"#BE185D","colorAccent":"#F472B6","fontHeading":"Cormorant Garamond","fontBody":"Inter","borderRadius":"16px"}'::jsonb,
    NULL),
  ('Бьюті Рожевий','beauty-rose', 'Класична б''юті рожево-фіолетова',  'general', 7,
    '{"colorPrimary":"#8B5CF6","colorSecondary":"#EC4899","colorAccent":"#F472B6","fontHeading":"Inter","fontBody":"Inter","borderRadius":"12px"}'::jsonb,
    '{"colorPrimary":"#A78BFA","colorSecondary":"#F472B6","colorAccent":"#F9A8D4","colorBg":"#1A1025"}'::jsonb),
  ('Сонячний',     'sunny',       'Тепла помаранчево-жовта гама',      'general', 8,
    '{"colorPrimary":"#C2410C","colorSecondary":"#EA580C","colorAccent":"#FB923C","fontHeading":"Inter","fontBody":"Inter","borderRadius":"14px"}'::jsonb,
    NULL)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
