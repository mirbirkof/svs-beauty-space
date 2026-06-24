-- 153: SAL-08 Procedure Materials — нормативные карты, факт.расход, себестоимость.
-- Базовый слой service_consumables (027) остаётся — это упрощённая привязка. Здесь
-- добавляется полноценное нормирование с коэффициентами (длина/густота), журнал
-- фактического расхода с отклонениями и расчётом себестоимости/маржи.
-- single-salon модель: integer id, ссылки на services/product_variants/appointments/clients.
BEGIN;

-- ── 153.1 Нормативные карты расхода ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_norms (
  id              SERIAL       PRIMARY KEY,
  service_id      INTEGER      REFERENCES services(id) ON DELETE CASCADE,
  service_variant VARCHAR(50),                         -- roots_only|full_length|highlights|NULL
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_by      INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_material_norms_service ON material_norms (service_id, status);

-- ── 153.2 Материалы в норме (с коэффициентами) ───────────────────────────────
CREATE TABLE IF NOT EXISTS procedure_materials (
  id               SERIAL      PRIMARY KEY,
  norm_id          INTEGER     NOT NULL REFERENCES material_norms(id) ON DELETE CASCADE,
  variant_id       INTEGER     NOT NULL REFERENCES product_variants(id),
  quantity         DECIMAL(8,2) NOT NULL,              -- базовое кол-во на 1 процедуру
  unit             VARCHAR(10)  NOT NULL DEFAULT 'g' CHECK (unit IN ('g','ml','pcs','pair')),
  coeff_short      DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  coeff_medium     DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  coeff_long       DECIMAL(3,2) NOT NULL DEFAULT 1.50,
  coeff_extra_long DECIMAL(3,2) NOT NULL DEFAULT 2.00,
  coeff_thin       DECIMAL(3,2) NOT NULL DEFAULT 0.80,
  coeff_normal     DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  coeff_thick      DECIMAL(3,2) NOT NULL DEFAULT 1.30,
  is_required      BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (norm_id, variant_id)
);
CREATE INDEX IF NOT EXISTS ix_procedure_materials_variant ON procedure_materials (variant_id);

-- ── 153.3 Журнал фактического расхода ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_consumption_log (
  id               SERIAL       PRIMARY KEY,
  appointment_id   INTEGER      REFERENCES appointments(id) ON DELETE SET NULL,
  service_id       INTEGER,
  employee_id      INTEGER,     -- master_id
  branch_id        INTEGER,
  client_id        INTEGER,
  variant_id       INTEGER      NOT NULL REFERENCES product_variants(id),
  norm_quantity    DECIMAL(8,2) NOT NULL,
  actual_quantity  DECIMAL(8,2),                       -- NULL = использована норма
  unit             VARCHAR(10)  NOT NULL DEFAULT 'g',
  deviation_pct    DECIMAL(6,1),
  deviation_reason VARCHAR(100),                       -- long_hair|damaged|test_strand|error|other
  deviation_note   TEXT,
  cost_norm        DECIMAL(10,2),
  cost_actual      DECIMAL(10,2),
  auto_written_off BOOLEAN      NOT NULL DEFAULT TRUE,
  reversed         BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mcl_appointment ON material_consumption_log (appointment_id);
CREATE INDEX IF NOT EXISTS ix_mcl_branch ON material_consumption_log (branch_id, created_at);
CREATE INDEX IF NOT EXISTS ix_mcl_employee ON material_consumption_log (employee_id, created_at);
CREATE INDEX IF NOT EXISTS ix_mcl_variant ON material_consumption_log (variant_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON material_norms, procedure_materials, material_consumption_log TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE material_norms_id_seq, procedure_materials_id_seq, material_consumption_log_id_seq TO app_tenant;

COMMIT;
