-- SAS-11 — Профіль майстра-одиночки (freemium).
-- Ідея власника: профіль + базові функції безкоштовні (щоб приводити клієнтуру
-- на платформу), решта модулів — платні add-on'и, що підключаються поштучно.
--
-- Механіка вже є: фічі = features плану + per-tenant overrides (routes/saas.js
-- effectiveFeatures). Тому solo = безкоштовний план з базовим набором, а платні
-- модулі вмикаються через overrides[feature]=true після оплати add-on'а.

-- 1) План 'solo': безкоштовний, 1 майстер. Базове ядро для залучення клієнтів:
--    публічний профіль/портфоліо + онлайн-запис + клієнти + послуги.
INSERT INTO saas_plans (code, name, price_month, price_year, features, limits, sort_order) VALUES
  ('solo', 'Майстер (Solo)', 0, 0,
   '["online_booking","clients","services","portfolio"]'::jsonb,
   '{"clients":300,"masters":1,"sms_month":0}'::jsonb, 0)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name, features=EXCLUDED.features, limits=EXCLUDED.limits, sort_order=EXCLUDED.sort_order;

-- 2) Каталог платних add-on модулів для solo (і будь-якого плану).
--    Кожен add-on вмикає одну фічу (feature_flags.key) за щомісячну ціну.
CREATE TABLE IF NOT EXISTS saas_addons (
  feature_key  TEXT PRIMARY KEY REFERENCES feature_flags(key),
  name         TEXT NOT NULL,
  description  TEXT,
  price_month  NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_year   NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO saas_addons (feature_key, name, description, price_month, price_year, sort_order) VALUES
  ('loyalty',           'Програма лояльності', 'Бонуси, кешбек, картки постійного клієнта', 149, 1490, 1),
  ('marketing',         'Маркетинг і розсилки', 'SMS/Email/Telegram кампанії, сегменти, акції', 199, 1990, 2),
  ('ai_receptionist',   'AI-адміністратор',     'Бот сам відповідає клієнтам і записує на процедури', 299, 2990, 3),
  ('ai_recommendations','AI-рекомендації',      'Підказки з допродажу, утримання, повернення клієнтів', 149, 1490, 4),
  ('forms',             'Конструктор форм',     'Анкети, згоди, опитування клієнтів', 99, 990, 5),
  ('webhooks',          'Вебхуки та інтеграції','Підключення зовнішніх систем через події', 149, 1490, 6)
ON CONFLICT (feature_key) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description,
  price_month=EXCLUDED.price_month, price_year=EXCLUDED.price_year, sort_order=EXCLUDED.sort_order;

-- 3) Тип акаунта в онбордингу (solo пропускає крок 'employees' — майстер один).
ALTER TABLE tenant_onboarding ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'salon';
