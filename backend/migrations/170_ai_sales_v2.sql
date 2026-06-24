-- 170: AI-02 AI Sales v2 — допродажі (upsell/cross-sell), win-back, next-best-offer.
-- Прагматична single-salon версія в стилі 161 (AI-07): INTEGER SERIAL, без UUID/tenant/RLS.
-- Спека описує UUID/branch_id — тут лишаємось у конвенції кодової бази (services/clients/
-- appointments = SERIAL int), branch_id опційний (NULL = всі точки, як у branches.id).
-- Тільки нові таблиці/колонки, усе через IF NOT EXISTS — ідемпотентно.
BEGIN;

-- ── 170.1 Згенеровані/відправлені пропозиції (offer'и) ───────────────────────
-- type:       upsell | cross_sell | win_back | nbo
-- offer_type: service | product | combo | discount
-- status:     pending | sent | accepted | declined | expired
CREATE TABLE IF NOT EXISTS ai_sales_offers (
  id                    SERIAL        PRIMARY KEY,
  client_id             INTEGER       REFERENCES clients(id) ON DELETE CASCADE,
  type                  VARCHAR(20)   NOT NULL,
  offer_type            VARCHAR(20)   NOT NULL DEFAULT 'service',
  offer_service_id      INTEGER       REFERENCES services(id),     -- послуга для upsell/cross-sell
  offer_product_id      TEXT          REFERENCES products(id),     -- товар (products.id = TEXT)
  rule_id               INTEGER,                                   -- з якого правила згенеровано
  chain_id              INTEGER,                                   -- з якої win-back цепочки
  chain_step            INTEGER,                                   -- індекс кроку цепочки
  offer_text            TEXT,
  channel               VARCHAR(20),  -- telegram | sms | email | in_app | master
  confidence            NUMERIC(4,3),                              -- ймовірність конверсії 0..1
  status                VARCHAR(20)   NOT NULL DEFAULT 'pending',
  sent_at               TIMESTAMPTZ,
  responded_at          TIMESTAMPTZ,
  result_appointment_id INTEGER       REFERENCES appointments(id),
  result_order_id       INTEGER       REFERENCES orders(id),
  result_revenue        NUMERIC(10,2),
  ab_variant            VARCHAR(10),  -- 'A' | 'B'
  expires_at            TIMESTAMPTZ   DEFAULT (now() + INTERVAL '14 days'),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_sales_offers_client  ON ai_sales_offers (client_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_sales_offers_type    ON ai_sales_offers (type, status);
CREATE INDEX IF NOT EXISTS idx_ai_sales_offers_created ON ai_sales_offers (created_at);

-- ── 170.2 Правила upsell / cross-sell ───────────────────────────────────────
-- «якщо клієнт бере trigger_service_id → запропонувати offer_service_id / offer_product_id».
CREATE TABLE IF NOT EXISTS ai_sales_rules (
  id                  SERIAL        PRIMARY KEY,
  branch_id           INTEGER       REFERENCES branches(id),   -- NULL = всі точки
  type                VARCHAR(20)   NOT NULL DEFAULT 'cross_sell', -- upsell | cross_sell | win_back
  trigger_service_id  INTEGER       REFERENCES services(id),
  offer_service_id    INTEGER       REFERENCES services(id),
  offer_product_id    TEXT          REFERENCES products(id),
  discount_percent    NUMERIC(5,2),
  min_confidence      NUMERIC(4,3)  NOT NULL DEFAULT 0.300,
  message_template    TEXT,
  active              BOOLEAN       NOT NULL DEFAULT TRUE,
  priority            INTEGER       NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_sales_rules_trigger ON ai_sales_rules (trigger_service_id, active);
CREATE INDEX IF NOT EXISTS idx_ai_sales_rules_active  ON ai_sales_rules (active, priority DESC);

-- ── 170.3 Win-back цепочки (мульти-кроковий сценарій повернення) ─────────────
-- steps JSONB: [{day,channel,template,offer_type,discount?}, ...]
CREATE TABLE IF NOT EXISTS ai_sales_winback_chains (
  id          SERIAL        PRIMARY KEY,
  branch_id   INTEGER       REFERENCES branches(id),
  name        VARCHAR(100)  NOT NULL,
  steps       JSONB         NOT NULL DEFAULT '[]',
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_sales_winback_active ON ai_sales_winback_chains (active);

-- ── 170.4 Сід дефолтної win-back цепочки (35→50→75 днів, як у спеці) ─────────
INSERT INTO ai_sales_winback_chains (name, steps, active)
SELECT 'Default win-back 35/50/75',
       '[{"day":35,"channel":"telegram","offer_type":"reminder","template":"{name}, давно вас не бачили! Записатися на улюблену послугу?"},
         {"day":50,"channel":"telegram","offer_type":"discount","discount":10,"template":"{name}, ми скучили — даруємо -10% на наступний візит."},
         {"day":75,"channel":"sms","offer_type":"personal","template":"{name}, персональна пропозиція тільки для вас. Деталі в салоні."}]'::jsonb,
       TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_sales_winback_chains);

COMMIT;
