-- MGT-08 — Конструктор форм (Forms Builder)
-- Формы: анкеты клиента, согласия, заявки, опросы. Поля хранятся как JSONB-схема.
CREATE TABLE IF NOT EXISTS forms (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  title        TEXT NOT NULL,
  slug         TEXT,                       -- для публичной ссылки
  description  TEXT,
  fields       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{key,label,type,required,options,placeholder}]
  status       TEXT NOT NULL DEFAULT 'draft',       -- draft|published|archived
  is_public    BOOLEAN NOT NULL DEFAULT false,      -- доступна без авторизации по slug
  success_message TEXT,
  submit_count INT NOT NULL DEFAULT 0,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_forms_slug ON forms (tenant_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_forms_tenant ON forms (tenant_id, status);

-- Ответы на формы.
CREATE TABLE IF NOT EXISTS form_submissions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  form_id     BIGINT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  client_id   BIGINT,                       -- если привязан к клиенту
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {key: value}
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_subs_form ON form_submissions (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_subs_tenant ON form_submissions (tenant_id);
