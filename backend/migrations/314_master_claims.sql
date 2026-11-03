-- 03.11 (Босс, мини-апп часть 2): заявка «Я майстер салону».
-- Человек в мини-аппе делится номером (подписанный Telegram контакт) и выбирает себя из списка
-- работающих мастеров. Владелец/админ подтверждает ✔ или отклоняет ✖ кнопкой в Telegram.
-- Без ✔ прав нет; номера/роли автоматически ни по какой эвристике не дописываются.
-- Только добавляет таблицу; существующие данные не трогает. Идемпотентна.
CREATE TABLE IF NOT EXISTS master_claims (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  tg_user_id   BIGINT NOT NULL,
  tg_name      TEXT,
  tg_username  TEXT,
  phone        TEXT NOT NULL,               -- только из подписанного контакта (user_id == from.id)
  master_id    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by   BIGINT,                      -- telegram_id того, кто нажал ✔/✖
  decided_at   TIMESTAMPTZ,
  result       JSONB,                       -- что именно записали при ✔ (для аудита)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Одна открытая заявка на человека (повторное нажатие не плодит запросы владельцу).
CREATE UNIQUE INDEX IF NOT EXISTS master_claims_one_pending
  ON master_claims (tenant_id, tg_user_id) WHERE status = 'pending';

ALTER TABLE master_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_claims;
CREATE POLICY tenant_isolation ON master_claims
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
