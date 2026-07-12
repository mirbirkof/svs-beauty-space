-- 252: системное закрытие тенант-пробела (аудит v6, мультитенант-эксперт, находки #2-#6).
-- Класс бага один: таблицы миграций 154-188 созданы в single-salon эпоху БЕЗ tenant_id →
-- динамический RLS (015/235/ensure-rls) их не видит. Итог: салон B читал/правил правила
-- upsell, winback-цепочки, видео, шаблоны смен, оргструктуру и KPI-метрики салона A;
-- ai_feature_store с глобальным UNIQUE(entity_type, entity_id) ПЕРЕЗАПИСЫВАЛ признаки
-- клиента одного салона данными другого (client_id совпадают между тенантами).
-- Здесь: tenant_id + пересборка глобальных UNIQUE в per-tenant + RLS + сид дефолтов.
BEGIN;

-- ── 1. tenant_id (существующие строки уходят дефолтному салону) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_sales_rules','ai_sales_winback_chains','ai_video_library',
    'shift_templates','shift_swaps','ai_feature_store',
    'departments','positions','specializations','kpi_metrics','gc_design_templates'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT current_tenant_id()', t);
  END LOOP;
END $$;

-- ── 2. глобальные UNIQUE → per-tenant (иначе второй салон ловит 500/коллизию) ──
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE con.contype = 'u'
       AND rel.relname IN ('ai_feature_store','specializations','kpi_metrics')
       AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
                       WHERE a.attname = 'tenant_id')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', c.relname, c.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_afs_tenant_entity ON ai_feature_store (tenant_id, entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spec_tenant_name  ON specializations (tenant_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kpim_tenant_code  ON kpi_metrics (tenant_id, code);

-- ── 3. сид дефолтов для салона (KPI-метрики, GC-шаблон, winback-цепочка) ──
-- Единственный источник правды: вызывается и здесь для существующих салонов,
-- и из tenant-mgmt.createTenant для новых.
CREATE OR REPLACE FUNCTION seed_tenant_defaults(tid uuid) RETURNS void AS $fn$
BEGIN
  INSERT INTO kpi_metrics (tenant_id, code, name, description, unit, direction, agg, default_weight)
  SELECT tid, s.* FROM (VALUES
    ('revenue',      'Виручка',        'Сума оплат за послуги майстра',      'uah',     'higher', 'sum', 0.40),
    ('avg_check',    'Середній чек',   'Виручка / кількість візитів',        'uah',     'higher', 'avg', 0.10),
    ('visits',       'Візити',         'Кількість виконаних візитів',        'count',   'higher', 'sum', 0.10),
    ('occupancy',    'Завантаження',   'Зайняті хвилини / робочі хвилини',   'percent', 'higher', 'avg', 0.15),
    ('repeat_rate',  'Повторні візити','Клієнти з >1 візитом / усі клієнти', 'percent', 'higher', 'avg', 0.10),
    ('noshow_rate',  'Неявки',         'Неявки / усі записи',                'percent', 'lower',  'avg', 0.05),
    ('new_clients',  'Нові клієнти',   'Первинні візити',                    'count',   'higher', 'sum', 0.05),
    ('rating',       'Рейтинг',        'Середній бал відгуків',              'rating',  'higher', 'avg', 0.05),
    ('product_sales','Продаж товарів', 'Допродажі товарів на візиті',        'uah',     'higher', 'sum', 0.00)
  ) AS s(code, name, description, unit, direction, agg, default_weight)
  WHERE NOT EXISTS (SELECT 1 FROM kpi_metrics k WHERE k.tenant_id = tid AND k.code = s.code);

  INSERT INTO gc_design_templates (tenant_id, name, type, html_template, css)
  SELECT tid, 'Стандартний', 'email',
    '<div class="gc-card"><div class="gc-head">Подарунковий сертифікат</div><div class="gc-amount">{номінал} грн</div><div class="gc-code">{код}</div><div class="gc-to">Для: {имя_получателя}</div><div class="gc-until">Дійсний до: {дата_до}</div></div>',
    '.gc-card{max-width:480px;margin:0 auto;padding:32px;border-radius:16px;background:linear-gradient(135deg,#1a1d24,#2a2f3a);color:#e8eaed;font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center}.gc-head{font-size:18px;color:#8ab4f8}.gc-amount{font-size:40px;font-weight:700;margin:16px 0}.gc-code{font-size:22px;letter-spacing:2px;font-weight:600}.gc-to,.gc-until{color:#9aa0a6;font-size:14px;margin-top:8px}'
  WHERE NOT EXISTS (SELECT 1 FROM gc_design_templates g WHERE g.tenant_id = tid);

  INSERT INTO ai_sales_winback_chains (tenant_id, name, steps, active)
  SELECT tid, 'Default win-back 35/50/75',
    '[{"day":35,"channel":"telegram","offer_type":"reminder","template":"{name}, давно вас не бачили! Записатися на улюблену послугу?"},
      {"day":50,"channel":"telegram","offer_type":"discount","discount":10,"template":"{name}, ми скучили — даруємо -10% на наступний візит."},
      {"day":75,"channel":"sms","offer_type":"personal","template":"{name}, персональна пропозиція тільки для вас. Деталі в салоні."}]'::jsonb,
    TRUE
  WHERE NOT EXISTS (SELECT 1 FROM ai_sales_winback_chains w WHERE w.tenant_id = tid);
END;
$fn$ LANGUAGE plpgsql;

SELECT seed_tenant_defaults(id) FROM tenants;

-- ── 4. RLS (политика идентична 222/251/ensure-rls) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_sales_rules','ai_sales_winback_chains','ai_video_library',
    'shift_templates','shift_swaps','ai_feature_store',
    'departments','positions','specializations','kpi_metrics','gc_design_templates'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
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
