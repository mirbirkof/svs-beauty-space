-- 300: Точки відкату графіка роботи (нотатка #156).
--
-- ПРИЧИНА: масова генерація графіка на місяці вперед перезаписує зміни без сліду.
-- 15.09.2026 власник згенерував графіки — і рукописний графік салону зник.
-- Повернути його змогли ЛИШЕ з нічного дампа руками розробника (кілька годин).
--
-- ФІКС: перед кожним масовим записом у графік система сама зберігає «як було»
-- (тільки зачеплені клітинки), і власник може відкотити одним кліком.
-- Нічого не видаляється: точки відкату — окрема додаткова таблиця.

CREATE TABLE IF NOT EXISTS schedule_undo_points (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind         TEXT NOT NULL,              -- generate | pattern | copy-week
  label        TEXT,                       -- людський опис для кнопки відкату
  author       TEXT,                       -- хто запустив
  cells        INT NOT NULL DEFAULT 0,     -- скільки клітинок зачеплено
  payload      JSONB NOT NULL,             -- { keys:[[master_id,date]...], rows:[...] }
  undone_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sched_undo_tenant ON schedule_undo_points(tenant_id, created_at DESC);

ALTER TABLE schedule_undo_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_undo_points FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schedule_undo_points;
CREATE POLICY tenant_isolation ON schedule_undo_points
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));
