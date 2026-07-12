-- 260: индекс под крон сгорания бонусов + ужесточение зеркального триггера (аудит-волна 4).
-- expireBonuses() сканит bonus_transactions WHERE remaining>0 AND expires_at<=now() — без
-- индекса это full scan по всем салонам. Триггер mirror_bonus_balance обновлял clients без
-- явного tenant_id в WHERE (defense-in-depth: clients.id глобально уникален, но фильтр по
-- тенанту исключает любой теоретический кросс-апдейт).
BEGIN;

-- индекс для крона сгорания (частичный — только «живые» лоты с датой сгорания)
CREATE INDEX IF NOT EXISTS ix_bonus_tx_expiry
  ON bonus_transactions (tenant_id, expires_at)
  WHERE remaining > 0 AND expires_at IS NOT NULL;

-- зеркало loyalty_points с явной tenant-изоляцией
CREATE OR REPLACE FUNCTION mirror_bonus_balance() RETURNS trigger AS $$
BEGIN
  UPDATE clients SET loyalty_points = ROUND(NEW.balance)::int
   WHERE id = NEW.client_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMIT;
