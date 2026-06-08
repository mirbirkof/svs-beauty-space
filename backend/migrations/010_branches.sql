-- ═══════════════════════════════════════════════════════
-- 010_branches.sql — Филиалы (multi-branch)
-- Базовый каркас. SVS сейчас в одной точке, но архитектура готова.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS branches (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE,                       -- 'main','satellite-1' и т.п.
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  city        TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  working_hours JSONB,                            -- {mon:{from:"09:00",to:"21:00"},...}
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Дефолтный филиал
INSERT INTO branches (code, name, address, city, is_default, is_active)
VALUES ('main', 'SVS Beauty Space — Main', NULL, NULL, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- Связь мастеров с филиалами (мастер может работать в нескольких)
CREATE TABLE IF NOT EXISTS master_branches (
  master_id  INTEGER NOT NULL,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (master_id, branch_id)
);

-- Добавляем branch_id в ключевые таблицы (если ещё нет)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='branch_id') THEN
    ALTER TABLE appointments ADD COLUMN branch_id INTEGER REFERENCES branches(id);
    UPDATE appointments SET branch_id=(SELECT id FROM branches WHERE is_default LIMIT 1) WHERE branch_id IS NULL;
    CREATE INDEX idx_appts_branch ON appointments(branch_id);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='branch_id') THEN
    ALTER TABLE orders ADD COLUMN branch_id INTEGER REFERENCES branches(id);
    UPDATE orders SET branch_id=(SELECT id FROM branches WHERE is_default LIMIT 1) WHERE branch_id IS NULL;
    CREATE INDEX idx_orders_branch ON orders(branch_id);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_variants' AND column_name='branch_id') THEN
    ALTER TABLE product_variants ADD COLUMN branch_id INTEGER REFERENCES branches(id);
    CREATE INDEX idx_variants_branch ON product_variants(branch_id);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Привязать существующие cash_shifts FK к branches
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name='cash_shifts_branch_fk') THEN
    ALTER TABLE cash_shifts ADD CONSTRAINT cash_shifts_branch_fk
      FOREIGN KEY (branch_id) REFERENCES branches(id);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
