-- SAS-04 Plans / SAS-05 Licenses / SAS-10 Feature Flags
-- Тарифные планы платформы.
CREATE TABLE IF NOT EXISTS saas_plans (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,        -- free | pro | enterprise
  name         TEXT NOT NULL,
  price_month  NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_year   NUMERIC(10,2) NOT NULL DEFAULT 0,
  features     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- список ключей фич, входящих в план
  limits       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {clients:1000, masters:5, sms_month:500}
  active       BOOLEAN NOT NULL DEFAULT true,
  sort_order   INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Глобальный реестр фич (SAS-10).
CREATE TABLE IF NOT EXISTS feature_flags (
  id           BIGSERIAL PRIMARY KEY,
  key          TEXT UNIQUE NOT NULL,        -- ai_receptionist | online_booking | webhooks ...
  name         TEXT,
  description  TEXT,
  default_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Лицензия арендатора: какой план + индивидуальные переопределения фич (SAS-05).
CREATE TABLE IF NOT EXISTS tenant_licenses (
  tenant_id    UUID PRIMARY KEY DEFAULT current_tenant_id(),
  plan_code    TEXT REFERENCES saas_plans(code),
  status       TEXT NOT NULL DEFAULT 'active',   -- active | trial | suspended | cancelled
  overrides    JSONB NOT NULL DEFAULT '{}'::jsonb, -- {feature_key: true/false} поверх плана
  trial_ends_at TIMESTAMPTZ,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Базовые планы (идемпотентно).
INSERT INTO saas_plans (code,name,price_month,price_year,features,limits,sort_order) VALUES
  ('free','Free',0,0,'["online_booking","clients","services"]'::jsonb,'{"clients":500,"masters":3,"sms_month":0}'::jsonb,1),
  ('pro','Pro',990,9900,'["online_booking","clients","services","loyalty","marketing","webhooks","portfolio","forms","ai_recommendations"]'::jsonb,'{"clients":10000,"masters":20,"sms_month":2000}'::jsonb,2),
  ('enterprise','Enterprise',2990,29900,'["*"]'::jsonb,'{"clients":-1,"masters":-1,"sms_month":-1}'::jsonb,3)
ON CONFLICT (code) DO NOTHING;

-- Базовые фичи.
INSERT INTO feature_flags (key,name,default_enabled) VALUES
  ('online_booking','Онлайн-запис',true),
  ('loyalty','Програма лояльності',true),
  ('marketing','Маркетинг та розсилки',true),
  ('webhooks','Вебхуки',false),
  ('portfolio','Портфоліо робіт',true),
  ('forms','Конструктор форм',true),
  ('ai_receptionist','AI-адміністратор',false),
  ('ai_recommendations','AI-рекомендації',true),
  ('public_api','Публічний API',false)
ON CONFLICT (key) DO NOTHING;
