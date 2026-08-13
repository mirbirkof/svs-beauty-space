-- 295: журнал подій платіжних шлюзів (біллінг SaaS).
-- ПРИЧИНА (аудит 13.08): вебхук /api/billing/webhooks/:gateway лише логував тіло і відповідав
-- {received:true}. Шлюз отримував 200 і НІКОЛИ не повторював подію: успішна оплата, провал,
-- повернення чи chargeback губились назавжди — підписка не активувалась/не блокувалась,
-- рахунок висів несплаченим при списаних грошах.
--
-- Таблиця дає ДВІ речі:
--   1) ідемпотентність — та сама подія шлюзу обробляється рівно один раз
--      (шлюзи штатно шлють дублікати при ретраях);
--   2) слід для розбору — що прийшло, як обробили, що пішло не так.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  gateway       TEXT        NOT NULL,               -- monobank | stripe | liqpay | manual
  event_id      TEXT        NOT NULL,               -- ідентифікатор події/платежу від шлюзу
  event_type    TEXT,                               -- нормалізований тип: paid|failed|refunded|other
  status        TEXT        NOT NULL DEFAULT 'received', -- received|processed|failed|ignored
  invoice_id    BIGINT,                             -- invoices_saas.id, якщо вдалось зіставити
  payment_id    BIGINT,                             -- payments_saas.id, якщо вдалось зіставити
  signature_ok  BOOLEAN,                            -- чи пройшла перевірка підпису
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

-- Ключ ідемпотентності: один шлюз + одна подія = один запис.
CREATE UNIQUE INDEX IF NOT EXISTS billing_webhook_events_uniq
  ON billing_webhook_events (gateway, event_id);

CREATE INDEX IF NOT EXISTS billing_webhook_events_created_idx
  ON billing_webhook_events (created_at DESC);

CREATE INDEX IF NOT EXISTS billing_webhook_events_status_idx
  ON billing_webhook_events (status) WHERE status <> 'processed';
