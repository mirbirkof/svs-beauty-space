-- 172: SLS-08 Gift Certificates v2 — дотягування до спеки.
-- Доповнює існуючу базу (056_gift_certificates.sql): серії, дизайн-шаблони,
-- продаж/активація (buyer/recipient/sold/activated), електронний формат (QR/email),
-- цільові сертифікати (service), аналітика (новий клієнт через сертифікат).
-- Тільки НОВЕ, все IF NOT EXISTS. Integer SERIAL, single-salon (без RLS) — як 056/160.
-- НЕ змінює існуючі дані; нові колонки nullable / з дефолтами.
BEGIN;

-- ── 172.1 Дизайн-шаблони сертифікатів ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gc_design_templates (
  id            SERIAL        PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  type          VARCHAR(20)   NOT NULL DEFAULT 'email',  -- email | print | telegram
  html_template TEXT          NOT NULL,
  css           TEXT,
  preview_url   VARCHAR(500),
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── 172.2 Серії (тиражний випуск) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_certificate_series (
  id                 SERIAL        PRIMARY KEY,
  name               VARCHAR(255)  NOT NULL,              -- 'Новорічний 2026'
  type               VARCHAR(20)   NOT NULL DEFAULT 'nominal',  -- nominal | service
  nominal_amount     NUMERIC(10,2),                       -- для nominal
  service_id         INTEGER,                             -- для service
  valid_days         INTEGER       NOT NULL DEFAULT 365,
  design_template_id INTEGER       REFERENCES gc_design_templates(id) ON DELETE SET NULL,
  service_restriction INTEGER[],                          -- послуги де можна використати (NULL = усі)
  quantity           INTEGER       NOT NULL DEFAULT 0,    -- скільки випущено в серії
  active             BOOLEAN       NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gc_series_active ON gift_certificate_series(active);

-- ── 172.3 Доповнення таблиці сертифікатів ────────────────────────────────────
-- Нові колонки для продажу/активації/електронного формату/серій.
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS series_id           INTEGER REFERENCES gift_certificate_series(id) ON DELETE SET NULL;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS qr_url              VARCHAR(500);
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS buyer_client_id     INTEGER REFERENCES clients(id);
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS recipient_client_id INTEGER REFERENCES clients(id);
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS recipient_email     VARCHAR(255);
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS sold_at             TIMESTAMPTZ;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS activated_at        TIMESTAMPTZ;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS valid_from          DATE;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS service_restriction INTEGER[];
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS sent_channel        VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_gc_series     ON gift_certificates(series_id);
CREATE INDEX IF NOT EXISTS idx_gc_recipient  ON gift_certificates(recipient_client_id);

-- ── 172.4 Доповнення журналу операцій ────────────────────────────────────────
-- Нові типи: sale | activation (на додачу до issue|usage|refund|cancellation|expiry).
ALTER TABLE gift_certificate_transactions ADD COLUMN IF NOT EXISTS cashbox_op_id INTEGER;

-- ── 172.5 Сід дефолтного дизайн-шаблону ──────────────────────────────────────
INSERT INTO gc_design_templates (name, type, html_template, css)
SELECT 'Стандартний', 'email',
  '<div class="gc-card"><div class="gc-head">Подарунковий сертифікат</div><div class="gc-amount">{номінал} грн</div><div class="gc-code">{код}</div><div class="gc-to">Для: {имя_получателя}</div><div class="gc-until">Дійсний до: {дата_до}</div></div>',
  '.gc-card{max-width:480px;margin:0 auto;padding:32px;border-radius:16px;background:linear-gradient(135deg,#1a1d24,#2a2f3a);color:#e8eaed;font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center}.gc-head{font-size:18px;color:#8ab4f8}.gc-amount{font-size:40px;font-weight:700;margin:16px 0}.gc-code{font-size:22px;letter-spacing:2px;font-weight:600}.gc-to,.gc-until{color:#9aa0a6;font-size:14px;margin-top:8px}'
WHERE NOT EXISTS (SELECT 1 FROM gc_design_templates);

COMMIT;
