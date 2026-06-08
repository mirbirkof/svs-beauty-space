-- ═══════════════════════════════════════════════════════
-- 008_roles.sql — Ролевая модель + аудит-лог
-- Роли: owner / admin / manager / master / reception / readonly
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 0,  -- 100=owner, 80=admin, 60=manager, 40=master, 30=reception, 10=readonly
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO roles (code, name, level, permissions) VALUES
  ('owner',    'Владелец',  100, '["*"]'::jsonb),
  ('admin',    'Адмін',      80, '["crm.*","shop.*","cashbox.*","reports.*","clients.*","masters.*","stock.*"]'::jsonb),
  ('manager',  'Менеджер',   60, '["shop.read","shop.write","cashbox.read","cashbox.write","clients.*","reports.read","stock.read"]'::jsonb),
  ('master',   'Майстер',    40, '["bookings.own","clients.read","cashbox.read.own","reports.own"]'::jsonb),
  ('reception','Рецепшен',   30, '["bookings.*","clients.*","cashbox.in","shop.read"]'::jsonb),
  ('readonly', 'Тільки чтение',10,'["*.read"]'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Пользователи системы (отдельно от clients/masters — это сотрудники с доступом)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  phone         TEXT UNIQUE,
  email         TEXT UNIQUE,
  password_hash TEXT,
  display_name  TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  master_id     INTEGER,                          -- если этот юзер = мастер, ссылка на masters
  branch_id     INTEGER,                          -- ограничение по филиалу (NULL = все)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_master ON users(master_id);

-- API токены (long-lived для интеграций + session-токены)
CREATE TABLE IF NOT EXISTS user_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,             -- SHA256(token)
  label       TEXT,
  expires_at  TIMESTAMPTZ,
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);

-- Audit log — все важные действия
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  user_label TEXT,                  -- denormalized для истории даже если юзера удалят
  action     TEXT NOT NULL,         -- 'order.create', 'cashbox.close', 'client.delete', etc
  entity     TEXT,                  -- 'order','client','shift','product'
  entity_id  INTEGER,
  ip         TEXT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
