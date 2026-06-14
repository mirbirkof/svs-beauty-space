-- 042: MKT-02 Авто-триггеры маркетинга (ДР, реактивация, возврат, no-show).
-- Триггеры — правила «событие/условие → сообщение». Cron раз в день
-- находит подходящих клиентов и ставит уведомления в Notification Hub.
CREATE TABLE IF NOT EXISTS marketing_triggers (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID,
  key           TEXT UNIQUE NOT NULL,         -- birthday|reactivation|winback|post_visit
  name          TEXT NOT NULL,
  enabled       BOOLEAN DEFAULT FALSE,        -- по умолчанию выключены (включает админ)
  template_key  TEXT NOT NULL,
  channel       TEXT DEFAULT 'any',
  params        JSONB DEFAULT '{}'::jsonb,    -- пороги (days_inactive, days_before_bd, ...)
  cooldown_days INTEGER DEFAULT 30,           -- не триггерить одного клиента чаще
  last_run_at   TIMESTAMPTZ,
  last_enqueued INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Встроенные триггеры (выключены — включаются вручную из админки)
INSERT INTO marketing_triggers(key, name, template_key, params, cooldown_days) VALUES
  ('birthday',     'День народження',          'birthday',     '{"days_before":0}'::jsonb, 300),
  ('reactivation', 'Засинають (45 днів)',      'reactivation', '{"days_inactive":45,"days_max":89}'::jsonb, 60),
  ('winback',      'Повернення втрачених (90+)','reactivation', '{"days_inactive":90}'::jsonb, 90)
ON CONFLICT (key) DO NOTHING;
