-- 251: закрытие тенант-пробела пайплайна визитов (аудит v6, находка мультитенант-эксперта).
-- visit_pipeline_stages и visit_stage_triggers созданы в 155 БЕЗ tenant_id (155 писалась
-- в single-salon эпоху), 222 закрыла только visit_stage_log. Итог: салон видел/правил
-- чужие стадии (name/color/SLA) и триггеры, а fireTriggers() стрелял вебхуками ОДНОГО
-- салона по записям ДРУГОГО. Здесь: tenant_id + per-tenant PK + сид стадий каждому
-- салону + RLS (политика идентична 222/ensure-rls).
BEGIN;

-- ── 1. tenant_id ──
ALTER TABLE visit_pipeline_stages ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();
ALTER TABLE visit_stage_triggers  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id();

-- ── 2. PK стадий: code (глобальный) → (tenant_id, code) ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visit_pipeline_stages_pkey'
               AND conrelid = 'visit_pipeline_stages'::regclass
               AND (SELECT count(*) FROM unnest(conkey)) = 1) THEN
    ALTER TABLE visit_pipeline_stages DROP CONSTRAINT visit_pipeline_stages_pkey;
    ALTER TABLE visit_pipeline_stages ADD PRIMARY KEY (tenant_id, code);
  END IF;
END $$;

-- ── 3. сид базовых стадий каждому салону, у которого их нет ──
INSERT INTO visit_pipeline_stages (tenant_id, code, name, position, color, sla_minutes, is_terminal)
SELECT t.id, s.code, s.name, s.position, s.color, s.sla_minutes, s.is_terminal
  FROM tenants t
  CROSS JOIN (VALUES
    ('booked',     'Заплановані',  0, '#6366f1', 1440, FALSE),
    ('confirmed',  'Підтверджені', 1, '#0ea5e9', 120,  FALSE),
    ('arrived',    'Прийшли',      2, '#f59e0b', 15,   FALSE),
    ('in_progress','В роботі',     3, '#8b5cf6', NULL, FALSE),
    ('done',       'Завершені',    4, '#16a34a', NULL, TRUE),
    ('noshow',     'Не прийшли',   5, '#dc2626', NULL, TRUE),
    ('cancelled',  'Скасовані',    6, '#94a3b8', NULL, TRUE)
  ) AS s(code, name, position, color, sla_minutes, is_terminal)
 WHERE NOT EXISTS (SELECT 1 FROM visit_pipeline_stages v
                    WHERE v.tenant_id = t.id AND v.code = s.code);

-- ── 4. индексы под per-tenant выборки ──
CREATE INDEX IF NOT EXISTS ix_vst_tenant_stage ON visit_stage_triggers (tenant_id, stage_code, active);

-- ── 5. RLS (fail-closed при заданном GUC, permissive без него — как 222/ensure-rls) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['visit_pipeline_stages','visit_stage_triggers'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
  END LOOP;
END $$;

COMMIT;
