-- 213: SaaS онлайн-запись, этап 1 — личные ТГ-боты салонов + изоляция напоминаний.
-- Босс (05.07): мастер-одиночка берёт CRM → вставляет токен своего бота от
-- BotFather → онлайн-запись работает через ЕГО бота автоматически.

-- 1) booking_reminders пропустила волну мультитенантности (миграция 126):
--    tenant_id + RLS по шаблону ядра (015/126).
ALTER TABLE public.booking_reminders
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();
CREATE INDEX IF NOT EXISTS booking_reminders_tenant_idx
  ON public.booking_reminders (tenant_id);
ALTER TABLE public.booking_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_reminders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.booking_reminders;
CREATE POLICY tenant_isolation ON public.booking_reminders
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

-- 2) Личный ТГ-бот каждого салона. Токен per-tenant, вебхук per-tenant.
--    Салон Босса продолжает работать на env TELEGRAM_BOT_TOKEN (fallback в коде).
CREATE TABLE IF NOT EXISTS tenant_bot_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  bot_token      text NOT NULL,
  bot_username   text,
  bot_name       text,
  webhook_secret text,
  webhook_url    text,
  status         text NOT NULL DEFAULT 'connected',
  connected_at   timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
ALTER TABLE tenant_bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_bot_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_bot_settings;
CREATE POLICY tenant_isolation ON tenant_bot_settings
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
