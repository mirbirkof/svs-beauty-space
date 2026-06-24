-- Migration 164: SAS-10 Feature Flags v2
-- Extends existing feature_flags + adds rules/overrides/rollouts/audit tables

-- ── 1. Extend feature_flags table ───────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'flag_type_enum') THEN
    CREATE TYPE flag_type_enum AS ENUM ('boolean','percentage','segment','multivariate');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'flag_status_enum') THEN
    CREATE TYPE flag_status_enum AS ENUM ('draft','active','deprecated','archived');
  END IF;
END $$;

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS flag_type        flag_type_enum   NOT NULL DEFAULT 'boolean',
  ADD COLUMN IF NOT EXISTS module_code      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS owner            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status           flag_status_enum NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS kill_switch      BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kill_switch_reason VARCHAR(255),
  ADD COLUMN IF NOT EXISTS kill_switch_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_flag_id   BIGINT REFERENCES feature_flags(id),
  ADD COLUMN IF NOT EXISTS tags             VARCHAR(50)[]    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metadata         JSONB            NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ff_module  ON feature_flags(module_code);
CREATE INDEX IF NOT EXISTS idx_ff_status  ON feature_flags(status);
CREATE INDEX IF NOT EXISTS idx_ff_tags    ON feature_flags USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_ff_kill    ON feature_flags(kill_switch) WHERE kill_switch = true;

-- ── 2. Rule types enum ──────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rule_type_enum') THEN
    CREATE TYPE rule_type_enum AS ENUM ('tenant_override','percentage','segment','time_based','plan_gate');
  END IF;
END $$;

-- ── 3. feature_flag_rules ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_rules (
  id          BIGSERIAL PRIMARY KEY,
  flag_id     BIGINT NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  rule_type   rule_type_enum NOT NULL,
  priority    SMALLINT NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  conditions  JSONB NOT NULL DEFAULT '{}',
  value       JSONB NOT NULL DEFAULT 'true',
  description VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ffr_flag ON feature_flag_rules(flag_id, priority);
CREATE INDEX IF NOT EXISTS idx_ffr_type ON feature_flag_rules(rule_type);

-- ── 4. feature_flag_overrides ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  id          BIGSERIAL PRIMARY KEY,
  flag_id     BIGINT NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  enabled     BOOLEAN NOT NULL,
  variant     VARCHAR(50),
  reason      VARCHAR(255),
  expires_at  TIMESTAMPTZ,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(flag_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_ffo_tenant  ON feature_flag_overrides(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ffo_expires ON feature_flag_overrides(expires_at) WHERE expires_at IS NOT NULL;

-- ── 5. rollout status enum ──────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rollout_status_enum') THEN
    CREATE TYPE rollout_status_enum AS ENUM ('planned','in_progress','paused','completed','rolled_back');
  END IF;
END $$;

-- ── 6. feature_rollouts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_rollouts (
  id               BIGSERIAL PRIMARY KEY,
  flag_id          BIGINT NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  status           rollout_status_enum NOT NULL DEFAULT 'planned',
  stages           JSONB NOT NULL DEFAULT '[]',
  current_stage    SMALLINT NOT NULL DEFAULT 0,
  current_percent  SMALLINT NOT NULL DEFAULT 0,
  auto_pause_rules JSONB NOT NULL DEFAULT '{}',
  paused_at        TIMESTAMPTZ,
  pause_reason     VARCHAR(255),
  completed_at     TIMESTAMPTZ,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fr_flag   ON feature_rollouts(flag_id);
CREATE INDEX IF NOT EXISTS idx_fr_status ON feature_rollouts(status);

-- ── 7. feature_flag_audit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_audit (
  id             BIGSERIAL PRIMARY KEY,
  flag_id        BIGINT NOT NULL REFERENCES feature_flags(id),
  action         VARCHAR(50) NOT NULL,
  actor_id       UUID,
  previous_value JSONB,
  new_value      JSONB,
  details        JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ffa_flag ON feature_flag_audit(flag_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ffa_ts   ON feature_flag_audit(created_at DESC);
