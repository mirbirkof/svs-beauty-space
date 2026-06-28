-- Зали / напрямки салону (заметка #76): дохід/витрати/прибуток по групах майстрів.
-- Зал = група майстрів (манікюр, перукарський, брови/візаж, масаж). Виручка послуг
-- групується по майстру продажу → точно збігається із загальною виручкою послуг
-- (на відміну від шляху через appointments.real_amount, який неповний).

CREATE TABLE IF NOT EXISTS salon_zones (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  color       VARCHAR(7) NOT NULL DEFAULT '#6366f1',  -- довільний колір для діаграм (#73-style)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Майстер належить максимум одному залу (UNIQUE master_id) — інакше виручка двоїться.
CREATE TABLE IF NOT EXISTS zone_masters (
  zone_id    INTEGER NOT NULL REFERENCES salon_zones(id) ON DELETE CASCADE,
  master_id  INTEGER NOT NULL,
  UNIQUE (master_id)
);
CREATE INDEX IF NOT EXISTS idx_zone_masters_zone ON zone_masters (zone_id);
