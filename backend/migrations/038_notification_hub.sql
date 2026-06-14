-- 038: COM-01 Notification Hub — единый шлюз уведомлений.
-- Абстрактный слой между бизнес-логикой и каналами доставки (Telegram/SMS/Email/...).
-- Очередь с приоритетами, шаблонизатор, маршрутизация, rate-limit, retry, трекинг доставки.

-- ── Шаблоны сообщений ──────────────────────────────────────────────
-- key — логический идентификатор (appt_remind_24h, order_paid, ...).
-- Один key может иметь варианты по каналу и языку.
CREATE TABLE IF NOT EXISTS notification_templates (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID,
  key         TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'any',          -- any|telegram|sms|email|push
  lang        TEXT NOT NULL DEFAULT 'uk',            -- uk|ru|en
  category    TEXT NOT NULL DEFAULT 'transactional', -- transactional|marketing|internal|system
  subject     TEXT,                                  -- для email/push
  body        TEXT NOT NULL,
  variables   JSONB DEFAULT '[]'::jsonb,             -- описание доступных переменных
  is_system   BOOLEAN DEFAULT FALSE,                 -- системные не удаляются из UI
  version     INTEGER DEFAULT 1,
  active       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ntpl_key_chan_lang
  ON notification_templates(COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid), key, channel, lang);

-- ── Единая очередь / журнал уведомлений ────────────────────────────
-- priority: 1=critical, 2=high, 3=normal, 4=low (меньше = срочнее).
-- status: queued → sending → sent → delivered → read | failed | bounced | cancelled | skipped
CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID,
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  template_key  TEXT,
  category      TEXT NOT NULL DEFAULT 'transactional',
  priority      SMALLINT NOT NULL DEFAULT 3,
  channel       TEXT NOT NULL DEFAULT 'telegram',    -- текущий канал доставки
  fallback_chain TEXT[] DEFAULT '{}',                -- [telegram,sms,email] — порядок отката
  recipient     TEXT,                                -- адрес в текущем канале (chat_id/phone/email)
  subject       TEXT,
  body          TEXT NOT NULL,
  payload       JSONB DEFAULT '{}'::jsonb,           -- исходные переменные + метаданные
  dedup_key     TEXT,                                -- защита от повторов
  status        TEXT NOT NULL DEFAULT 'queued',
  scheduled_at  TIMESTAMPTZ DEFAULT NOW(),           -- не отправлять раньше
  ttl_at        TIMESTAMPTZ,                         -- после — не отправлять (просрочено)
  attempts      INTEGER DEFAULT 0,
  max_attempts  INTEGER DEFAULT 3,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  provider_msg_id TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  last_error    TEXT,
  source        TEXT,                                -- модуль-источник (reminders/orders/campaign:NN)
  created_by    INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
-- Воркер очереди: берём готовые к отправке по приоритету
CREATE INDEX IF NOT EXISTS idx_notif_queue
  ON notifications(status, next_attempt_at, priority)
  WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS idx_notif_client ON notifications(client_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_dedup
  ON notifications(dedup_key) WHERE dedup_key IS NOT NULL;

-- ── Настройки доставки на салон (rate-limit, DND, пауза) ────────────
CREATE TABLE IF NOT EXISTS notification_settings (
  tenant_id          UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  paused             BOOLEAN DEFAULT FALSE,
  queue_max          INTEGER DEFAULT 5000,
  daily_limit_client INTEGER DEFAULT 5,       -- макс маркетинг-уведомлений клиенту в сутки
  cooldown_minutes   INTEGER DEFAULT 5,       -- минимум между сообщениями одному клиенту
  dnd_start          SMALLINT DEFAULT 22,     -- час начала тихого режима (Europe/Kyiv)
  dnd_end            SMALLINT DEFAULT 9,       -- час конца тихого режима
  default_chain      TEXT[] DEFAULT '{telegram,sms,email}',
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO notification_settings(tenant_id) VALUES ('00000000-0000-0000-0000-000000000000'::uuid)
  ON CONFLICT DO NOTHING;

-- ── Подписки/предпочтения клиента ──────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_prefs (
  client_id         INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  channel_priority  TEXT[] DEFAULT '{telegram,sms,email}',
  marketing_opt_in  BOOLEAN DEFAULT TRUE,
  transactional_opt_in BOOLEAN DEFAULT TRUE,
  dnd_start         SMALLINT,                 -- индивидуальный DND (NULL = брать салонный)
  dnd_end           SMALLINT,
  tz                TEXT DEFAULT 'Europe/Kyiv',
  unsubscribed_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Системные шаблоны (перенос хардкода reminders/orders в Hub) ─────
INSERT INTO notification_templates(key, channel, lang, category, body, is_system, variables) VALUES
  ('appt_remind_24h','any','uk','transactional',
   '📋 <b>Нагадування</b>\nЗавтра о {{time}} у вас запис{{#if master}} до майстра <b>{{master}}</b>{{/if}}{{#if service}} ({{service}}){{/if}}.\n\nЯкщо потрібно перенести — напишіть нам.',
   TRUE,'["time","master","service"]'::jsonb),
  ('appt_remind_2h','any','uk','transactional',
   '⏰ Через 2 години ваш візит о <b>{{time}}</b>{{#if master}} у <b>{{master}}</b>{{/if}}. Чекаємо на вас!',
   TRUE,'["time","master"]'::jsonb),
  ('appt_feedback','any','uk','transactional',
   '💬 <b>{{client}}!</b>\nЯк вам сьогоднішній візит{{#if master}} у <b>{{master}}</b>{{/if}}?\n\nОцініть від 1 до 5:\n1 ⭐ — погано\n3 ⭐⭐⭐ — нормально\n5 ⭐⭐⭐⭐⭐ — чудово',
   TRUE,'["client","master"]'::jsonb),
  ('birthday','any','uk','marketing',
   '🎂 <b>{{client}}, вітаємо з Днем народження!</b>\nДаруємо вам персональну знижку. Чекаємо у гості 💐',
   TRUE,'["client"]'::jsonb),
  ('reactivation','any','uk','marketing',
   '💛 <b>{{client}}, ми скучили!</b>\nВи давно не заходили. Повертайтесь — у нас є приємна пропозиція для вас.',
   TRUE,'["client"]'::jsonb)
ON CONFLICT DO NOTHING;
