-- 287: Автопилот кассовых смен + контроль аккаунта админа (задача Босса 11.08.2026)
--
-- ПРИЧИНА: кассовая смена #191 была открыта 02.07 и не закрыта до 11.08 — смены
-- открывают/закрывают руками, а значит не делают. Ответственный (opened_by) везде NULL,
-- то есть по кассе невозможно сказать, кто в ней работал. Плюс CRM никак не проверяла,
-- работает ли админ в СВОЮ смену по графику (master_schedule_days).

-- Кто открыл/закрыл в терминах АККАУНТА (users), а не только мастера.
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS opened_by_user_id INTEGER;
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS closed_by_user_id INTEGER;
-- Признак, что смену открыл/закрыл автопилот, а не человек (для отчётов и разбора).
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS auto_opened BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT FALSE;
-- Плановое окно смены по графику, на основании которого автопилот принял решение.
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS planned_start TIMESTAMPTZ;
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS planned_end   TIMESTAMPTZ;

-- Журнал: кто и с какого аккаунта работал в CRM и его ли это была смена.
-- Пишем НЕ каждый запрос (это шум), а факт «аккаунт активен в такую-то смену»:
-- одна запись на аккаунт в сутки + обновление last_seen_at.
CREATE TABLE IF NOT EXISTS shift_login_audit (
  id           SERIAL PRIMARY KEY,
  work_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
  user_id      INTEGER     NOT NULL,
  master_id    INTEGER,                     -- к какому сотруднику привязан аккаунт
  display_name TEXT,
  role_id      INTEGER,
  verdict      TEXT        NOT NULL,        -- own_shift | off_shift | no_schedule | owner
  shift_id     INTEGER,                     -- кассовая смена, в которой шла работа
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count   INTEGER     NOT NULL DEFAULT 1,
  ip           TEXT,
  alerted_at   TIMESTAMPTZ,                 -- когда владельцу ушёл алерт (чтобы не спамить)
  UNIQUE (work_date, user_id, verdict)
);
CREATE INDEX IF NOT EXISTS idx_shift_audit_date ON shift_login_audit(work_date DESC);
CREATE INDEX IF NOT EXISTS idx_shift_audit_user ON shift_login_audit(user_id, work_date DESC);
