/* Boot-time самопочинка RLS (пресейл-блокер #2).
 *
 * Зачем: миграция 235 включает RLS на всех таблицах с tenant_id, но она
 * записывается в _migrations и больше не повторяется. После фейловера на
 * backup-БД (neon-sync) таблица _migrations КОПИРУЕТСЯ вместе с данными, так
 * что раннер считает 235 «применённой» и не проводит её заново — а сами
 * RLS-политики neon-sync не переносил → изоляция снова отключена.
 *
 * Поэтому при КАЖДОМ старте сервиса мы независимо от _migrations прогоняем
 * тот же динамический ассерт: для каждой base-таблицы public с колонкой
 * tenant_id типа uuid включаем ENABLE+FORCE RLS и (пере)создаём политику
 * tenant_isolation. Идемпотентно, дёшево, self-healing.
 *
 * DDL идёт под ВЛАДЕЛЬЦЕМ БД (DATABASE_URL, обычно neondb_owner) — отдельным
 * пулом, т.к. рабочий пул ходит под app_tenant, который не может ALTER чужие
 * таблицы. Ошибки не роняют старт сервиса (только логируем).
 */
const { Pool } = require('pg');

/* Платформенно-управляемые таблицы: имеют tenant_id, но писать/читать в них должен
 * ПЛАТФОРМЕННЫЙ код в чужой тенант (tenant-mgmt.js: createTenant/purge, billing,
 * public-signup). tenant_isolation (fail-closed при GUC) ломает signup: запрос идёт
 * в контексте дефолтного тенанта, а строки создаются для НОВОГО (E2E-аудит 10.07:
 * «new row violates RLS for subscriptions_saas/licenses»). Изоляция здесь — явными
 * WHERE tenant_id=$1 (дизайн lib/tenant-mgmt.js, шапка). staff_otp_throttle —
 * глобальный анти-brute-force (PK по key, ключи pwd:ip:* общие между салонами):
 * per-tenant политика валила login-password 500 (upsert в невидимую строку). */
const PLATFORM_MANAGED = [
  '_migrations', 'subscriptions_saas', 'invoices_saas', 'tenant_addon_subscriptions',
  'licenses', 'tenant_onboarding', 'staff_otp_throttle',
];
const EXCLUDE_SQL = PLATFORM_MANAGED.map(t => `'${t}'`).join(', ');

const ENSURE_SQL = `
DO $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema
       AND tb.table_name  = c.table_name
       AND tb.table_type  = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND c.data_type    = 'uuid'
       AND c.table_name NOT IN (${EXCLUDE_SQL})
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public'
            AND p.tablename  = c.table_name
            AND p.policyname = 'tenant_isolation'
       )
     ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id)) '
      'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid, tenant_id))', t);
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE 'ensure-rls: восстановил tenant_isolation на % таблицах', n;
  END IF;
END $$;`;

// Возвращает число «починенных» таблиц (грубо — через NOTICE не читаем, поэтому
// повторно считаем сколько таблиц с tenant_id остались БЕЗ политики ПОСЛЕ прогона).
async function ensureTenantRls() {
  // Владельческий URL: DATABASE_URL (НЕ _APP). Без него DDL невозможен.
  const url = process.env.DATABASE_URL;
  if (!url) { console.warn('[ensure-rls] DATABASE_URL не задан — пропуск'); return null; }
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('neon.tech') || url.includes('supabase') ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
  });
  try {
    // сколько таблиц было незакрыто ДО
    const before = await pool.query(`
      SELECT count(*)::int AS c
        FROM information_schema.columns c
       WHERE c.table_schema='public' AND c.column_name='tenant_id' AND c.data_type='uuid'
         AND c.table_name NOT IN (${EXCLUDE_SQL})
         AND NOT EXISTS (SELECT 1 FROM pg_policies p
                          WHERE p.schemaname='public' AND p.tablename=c.table_name
                            AND p.policyname='tenant_isolation')`);
    const gaps = before.rows[0].c;
    if (gaps > 0) {
      await pool.query(ENSURE_SQL);
      console.log(`[ensure-rls] закрыл RLS на ${gaps} таблицах с tenant_id (было без политики)`);
    } else {
      console.log('[ensure-rls] все таблицы с tenant_id уже изолированы');
    }
    return gaps;
  } catch (e) {
    console.error('[ensure-rls] FAILED (сервис продолжает работать):', e.message);
    return null;
  } finally {
    try { await pool.end(); } catch (_) {}
  }
}

module.exports = { ensureTenantRls, ENSURE_SQL };
