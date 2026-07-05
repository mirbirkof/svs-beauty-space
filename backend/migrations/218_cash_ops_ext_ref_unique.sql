-- Ідемпотентність зовнішніх операцій каси (POS-кошик, вебхуки):
-- повторний POST з тим самим ext_ref не створює другу операцію (аудит 06.07).
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ops_ext_ref
  ON cash_operations (tenant_id, ext_ref) WHERE ext_ref IS NOT NULL;
