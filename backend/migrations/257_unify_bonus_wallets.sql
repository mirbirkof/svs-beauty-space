-- 257: ЕДИНЫЙ кошелёк бонусов (аудит v6, блокер #5).
-- Было ДВА несинхронных кошелька: A) clients.loyalty_points + loyalty_ledger (магазин,
-- рефералка, кабинет, карточка клиента) и B) bonus_balances/bonus_transactions (касса,
-- визиты, мобильный, бот-история). Заказы начисляли В ОБА (двойной бонус), клиент видел
-- в кабинете баланс, который негде потратить, и не видел бонусы за визиты.
-- Решение: канон = B. Остатки A переносятся в B; clients.loyalty_points становится
-- ЗЕРКАЛОМ B (триггер) — все легаси-экраны (карточка, экспорт, BI, сегменты, бот)
-- автоматически показывают единый баланс без правок.
BEGIN;

-- ── 1. перенос положительных остатков legacy-кошелька в единый ──
WITH pts AS (
  SELECT id AS client_id, tenant_id, loyalty_points::numeric AS amount
    FROM clients WHERE COALESCE(loyalty_points, 0) > 0
),
ins AS (
  INSERT INTO bonus_transactions
    (tenant_id, client_id, type, amount, balance_after, remaining,
     source_type, source_id, description, expires_at, available_at)
  SELECT p.tenant_id, p.client_id, 'manual_add', p.amount,
         COALESCE(bb.balance, 0) + p.amount, p.amount,
         'migration', p.client_id,
         'Об''єднання кошельків (257): перенос бонусів магазину/рефералки',
         now() + interval '365 days', now()
    FROM pts p
    LEFT JOIN bonus_balances bb ON bb.tenant_id = p.tenant_id AND bb.client_id = p.client_id
  RETURNING tenant_id, client_id, amount
)
INSERT INTO bonus_balances (tenant_id, client_id, balance, total_accrued, last_accrual_at)
SELECT tenant_id, client_id, amount, amount, now() FROM ins
ON CONFLICT (tenant_id, client_id) DO UPDATE
  SET balance = bonus_balances.balance + EXCLUDED.balance,
      total_accrued = bonus_balances.total_accrued + EXCLUDED.total_accrued,
      last_accrual_at = now(), updated_at = now();

-- аудиторский след в старом ledger (история не удаляется)
INSERT INTO loyalty_ledger (client_id, delta, reason, ref_id)
SELECT id, -loyalty_points, 'migrated-to-bonus-wallet', '257'
  FROM clients WHERE COALESCE(loyalty_points, 0) > 0;

-- ── 2. clients.loyalty_points = зеркало единого кошелька ──
CREATE OR REPLACE FUNCTION mirror_bonus_balance() RETURNS trigger AS $$
BEGIN
  UPDATE clients SET loyalty_points = ROUND(NEW.balance)::int
   WHERE id = NEW.client_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mirror_bonus_balance ON bonus_balances;
CREATE TRIGGER trg_mirror_bonus_balance
  AFTER INSERT OR UPDATE OF balance ON bonus_balances
  FOR EACH ROW EXECUTE FUNCTION mirror_bonus_balance();

-- ── 3. первичная синхронизация зеркала ──
UPDATE clients c SET loyalty_points = ROUND(bb.balance)::int
  FROM bonus_balances bb
 WHERE bb.client_id = c.id AND bb.tenant_id = c.tenant_id
   AND c.loyalty_points IS DISTINCT FROM ROUND(bb.balance)::int;

UPDATE clients SET loyalty_points = 0
 WHERE COALESCE(loyalty_points, 0) <> 0
   AND NOT EXISTS (SELECT 1 FROM bonus_balances bb
                    WHERE bb.client_id = clients.id AND bb.tenant_id = clients.tenant_id);

COMMIT;
