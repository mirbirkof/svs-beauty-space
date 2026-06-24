-- 176: MGT-08 Forms Builder v2 — дотягування до спеки.
-- Доповнює існуючу базу (087_forms.sql): forms + form_submissions.
-- Додає: розширені колонки форм (slug-публікація, доступ, дедлайн, ліміти,
-- брендинг, on_submit-дії, шаблони, лічильники), нормалізовані поля (form_fields)
-- зі статусами/секціями/умовною логікою, значення відповідей (form_field_values),
-- метадані відповідей (статуси/джерело/пристрій/тривалість), лог переглядів
-- (form_views) для аналітики конверсії, та сід системних шаблонів форм.
-- Тільки НОВЕ, все IF NOT EXISTS / ADD COLUMN IF NOT EXISTS. Не змінює існуючі дані;
-- нові колонки nullable / з дефолтами. BIGSERIAL + tenant_id — як 087.
BEGIN;

-- ── 176.1 Розширення таблиці forms ───────────────────────────────────────────
-- Публікація/доступ.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS access_type       VARCHAR(20)  NOT NULL DEFAULT 'public';   -- public | link_only | authenticated
ALTER TABLE forms ADD COLUMN IF NOT EXISTS deadline_at       TIMESTAMPTZ;                                -- NULL = без дедлайна
ALTER TABLE forms ADD COLUMN IF NOT EXISTS max_submissions   INTEGER;                                    -- NULL = без ліміту
ALTER TABLE forms ADD COLUMN IF NOT EXISTS view_count        INTEGER      NOT NULL DEFAULT 0;
-- Конструктор.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS is_multi_page     BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE forms ADD COLUMN IF NOT EXISTS pages_config      JSONB        NOT NULL DEFAULT '[]'::jsonb;  -- [{"title": "...", "fields": [...]}]
ALTER TABLE forms ADD COLUMN IF NOT EXISTS settings          JSONB        NOT NULL DEFAULT '{}'::jsonb;  -- {captcha, one_per_email, one_per_phone, rate_limit}
ALTER TABLE forms ADD COLUMN IF NOT EXISTS branding          JSONB        NOT NULL DEFAULT '{}'::jsonb;  -- {logo_url, primary_color, thank_you_message}
ALTER TABLE forms ADD COLUMN IF NOT EXISTS closed_message    TEXT;                                       -- текст сторінки "форма закрита"
-- Дії при заповненні (create_client | notify | webhook).
ALTER TABLE forms ADD COLUMN IF NOT EXISTS on_submit_actions JSONB        NOT NULL DEFAULT '[]'::jsonb;
-- Шаблони.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS is_template       BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE forms ADD COLUMN IF NOT EXISTS template_category VARCHAR(50);                                -- client_intake | feedback | vacancy | checklist | consent | medical
-- М'яке видалення.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_forms_template ON forms (is_template, template_category) WHERE is_template = true;
CREATE INDEX IF NOT EXISTS idx_forms_deadline ON forms (deadline_at) WHERE deadline_at IS NOT NULL;

-- ── 176.2 Нормалізовані поля форми (на додачу до forms.fields JSONB) ──────────
-- Дозволяє покольоночні аналітику/умовну логіку/валідацію без парсингу JSONB.
CREATE TABLE IF NOT EXISTS form_fields (
  id                BIGSERIAL    PRIMARY KEY,
  tenant_id         UUID         NOT NULL DEFAULT current_tenant_id(),
  form_id           BIGINT       NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  page_index        INTEGER      NOT NULL DEFAULT 0,
  section_title     VARCHAR(255),
  field_type        VARCHAR(30)  NOT NULL,             -- short_text|long_text|number|email|phone|date|time|datetime|select|multi_select|radio|checkbox|file_upload|signature|rating|scale|divider|heading|paragraph
  field_key         VARCHAR(100) NOT NULL,             -- унікальний ключ поля в формі
  label             VARCHAR(500) NOT NULL,
  placeholder       VARCHAR(255),
  help_text         TEXT,
  is_required       BOOLEAN      NOT NULL DEFAULT false,
  default_value     TEXT,
  options           JSONB,                              -- [{"value":"yes","label":"Так"}]
  validation        JSONB,                              -- {min,max,minLength,maxLength,pattern,file_types}
  conditional_rules JSONB,                              -- [{"field_key":"...","op":"eq","value":"...","action":"show"}]
  sort_order        INTEGER      NOT NULL DEFAULT 0,
  is_hidden         BOOLEAN      NOT NULL DEFAULT false,
  metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (form_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields (form_id, page_index, sort_order);

-- ── 176.3 Розширення відповідей (form_submissions) ───────────────────────────
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS status           VARCHAR(20)  NOT NULL DEFAULT 'new';  -- new|reviewed|processed|archived
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS is_starred       BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS source           VARCHAR(20);                            -- direct_link|qr|iframe|telegram|email
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS device_type      VARCHAR(10);                            -- desktop|mobile|tablet
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS reviewed_at      TIMESTAMPTZ;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS reviewed_by      BIGINT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS metadata         JSONB        NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_form_subs_status ON form_submissions (form_id, status) WHERE deleted_at IS NULL;

-- ── 176.4 Значення відповідей (нормалізовані, для фільтрації/аналітики) ───────
CREATE TABLE IF NOT EXISTS form_field_values (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       UUID         NOT NULL DEFAULT current_tenant_id(),
  submission_id   BIGINT       NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  field_id        BIGINT       REFERENCES form_fields(id) ON DELETE SET NULL,
  field_key       VARCHAR(100) NOT NULL,
  value_text      TEXT,
  value_number    NUMERIC(15,4),
  value_date      DATE,
  value_json      JSONB,                                 -- multi_select / file (масиви)
  file_id         UUID         REFERENCES files(id) ON DELETE SET NULL,  -- для file_upload
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_field_values_submission ON form_field_values (submission_id);
CREATE INDEX IF NOT EXISTS idx_field_values_key ON form_field_values (field_key, value_text);

-- ── 176.5 Лог переглядів форми (для воронки/конверсії/джерел/пристроїв) ───────
CREATE TABLE IF NOT EXISTS form_views (
  id          BIGSERIAL    PRIMARY KEY,
  tenant_id   UUID         NOT NULL DEFAULT current_tenant_id(),
  form_id     BIGINT       NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  source      VARCHAR(20),                                -- direct_link|qr|iframe|telegram|email
  device_type VARCHAR(10),                                -- desktop|mobile|tablet
  ip          TEXT,
  viewed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_views_form ON form_views (form_id, viewed_at DESC);

-- ── 176.6 Сід системних шаблонів форм ────────────────────────────────────────
-- is_template=true, template_category. Поля у JSONB-схемі (forms.fields) —
-- сумісно з існуючим конструктором; нормалізовані form_fields створює роут при
-- клонуванні шаблону. Сід тенант-агностичний (DEFAULT_TENANT '0000...').
INSERT INTO forms (tenant_id, title, description, fields, status, is_public, is_template, template_category, success_message)
SELECT '00000000-0000-0000-0000-000000000000'::uuid,
  'Анкета нового клієнта',
  'Базова анкета для першого візиту: контакти, дата народження, побажання.',
  '[{"key":"name","label":"Ім''я та прізвище","type":"text","required":true},{"key":"phone","label":"Телефон","type":"phone","required":true},{"key":"email","label":"Email","type":"email","required":false},{"key":"birthday","label":"Дата народження","type":"date","required":false},{"key":"source","label":"Звідки про нас дізналися","type":"select","required":false,"options":["Instagram","Google","Рекомендація","Інше"]},{"key":"wishes","label":"Побажання","type":"textarea","required":false}]'::jsonb,
  'draft', true, true, 'client_intake', 'Дякуємо! Ваша анкета збережена.'
WHERE NOT EXISTS (SELECT 1 FROM forms WHERE is_template = true AND template_category = 'client_intake');

INSERT INTO forms (tenant_id, title, description, fields, status, is_public, is_template, template_category, success_message)
SELECT '00000000-0000-0000-0000-000000000000'::uuid,
  'Згода на обробку персональних даних',
  'Форма згоди на обробку персональних даних (GDPR/152-ФЗ-подібна).',
  '[{"key":"full_name","label":"ПІБ","type":"text","required":true},{"key":"phone","label":"Телефон","type":"phone","required":true},{"key":"consent","label":"Я надаю згоду на обробку моїх персональних даних","type":"checkbox","required":true},{"key":"consent_marketing","label":"Згоден отримувати маркетингові повідомлення","type":"checkbox","required":false},{"key":"signature","label":"Підпис","type":"signature","required":true},{"key":"date","label":"Дата","type":"date","required":true}]'::jsonb,
  'draft', true, true, 'consent', 'Дякуємо! Вашу згоду зафіксовано.'
WHERE NOT EXISTS (SELECT 1 FROM forms WHERE is_template = true AND template_category = 'consent');

INSERT INTO forms (tenant_id, title, description, fields, status, is_public, is_template, template_category, success_message)
SELECT '00000000-0000-0000-0000-000000000000'::uuid,
  'Медична картка (анкета здоров''я)',
  'Опитувальник перед процедурою: алергії, протипоказання, хронічні захворювання.',
  '[{"key":"full_name","label":"ПІБ","type":"text","required":true},{"key":"birthday","label":"Дата народження","type":"date","required":true},{"key":"has_allergy","label":"Чи є алергія?","type":"radio","required":true,"options":["Так","Ні"]},{"key":"allergen","label":"Вкажіть алерген","type":"text","required":false},{"key":"chronic","label":"Хронічні захворювання","type":"textarea","required":false},{"key":"pregnancy","label":"Вагітність/лактація","type":"radio","required":false,"options":["Так","Ні","Не застосовно"]},{"key":"medications","label":"Препарати, які приймаєте","type":"textarea","required":false},{"key":"consent","label":"Підтверджую достовірність наданих даних","type":"checkbox","required":true}]'::jsonb,
  'draft', true, true, 'medical', 'Дякуємо! Анкету збережено. Майстер ознайомиться перед процедурою.'
WHERE NOT EXISTS (SELECT 1 FROM forms WHERE is_template = true AND template_category = 'medical');

INSERT INTO forms (tenant_id, title, description, fields, status, is_public, is_template, template_category, success_message)
SELECT '00000000-0000-0000-0000-000000000000'::uuid,
  'Форма зворотного зв''язку',
  'Оцінка візиту та коментарі клієнта.',
  '[{"key":"name","label":"Ваше ім''я","type":"text","required":false},{"key":"rating","label":"Оцініть візит","type":"rating","required":true},{"key":"comment","label":"Коментар","type":"textarea","required":false},{"key":"contact_back","label":"Передзвонити мені","type":"checkbox","required":false}]'::jsonb,
  'draft', true, true, 'feedback', 'Дякуємо за відгук!'
WHERE NOT EXISTS (SELECT 1 FROM forms WHERE is_template = true AND template_category = 'feedback');

INSERT INTO forms (tenant_id, title, description, fields, status, is_public, is_template, template_category, success_message)
SELECT '00000000-0000-0000-0000-000000000000'::uuid,
  'Заявка на вакансію',
  'Анкета кандидата: контакти, досвід, резюме.',
  '[{"key":"full_name","label":"ПІБ","type":"text","required":true},{"key":"phone","label":"Телефон","type":"phone","required":true},{"key":"email","label":"Email","type":"email","required":true},{"key":"position","label":"Бажана посада","type":"text","required":true},{"key":"experience","label":"Досвід роботи","type":"textarea","required":false},{"key":"resume","label":"Резюме (файл)","type":"file","required":false}]'::jsonb,
  'draft', true, true, 'vacancy', 'Дякуємо! Ми розглянемо вашу заявку та звʼяжемося.'
WHERE NOT EXISTS (SELECT 1 FROM forms WHERE is_template = true AND template_category = 'vacancy');

COMMIT;
