#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   tenant-isolation-check.js — СТОРОЖ ІЗОЛЯЦІЇ САЛОНІВ (SaaS-критично)

   НАВІЩО: у мультиорендній CRM найдорожча помилка — коли салон Б бачить дані
   салону А. Разова перевірка нічого не гарантує: нова таблиця/новий роут легко
   ламають ізоляцію мовчки. Цей скрипт перевіряє її ФАКТОМ, а не вірою в код:
   підключається як конкретний орендар (SET LOCAL ROLE app_tenant + app.tenant_id)
   і дивиться, чи справді не видно чужих рядків.

   ЩО ПЕРЕВІРЯЄ:
     1) RLS увімкнено (і FORCE) на кожній таблиці з колонкою tenant_id;
     2) роль app_tenant існує і НЕ має BYPASSRLS;
     3) бойовий тест витоку: під кожним орендарем читаємо ключові таблиці —
        жодного рядка чужого tenant_id бути не повинно;
     4) таблиці з tenant_id, але БЕЗ жодної RLS-політики — тиха діра.

   ЗАПУСК:  node ops/tenant-isolation-check.js
   Код виходу: 0 — чисто, 1 — знайдено проблеми (придатний для крона/CI).
   ═══════════════════════════════════════════════════════════════════════════ */
// pg/dotenv живуть у backend/node_modules — скрипт лежить в ops/, тому резолвимо звідти
const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const APP_ROLE = process.env.DB_APP_ROLE || 'app_tenant';
// Таблиці, для яких RLS ВИМКНЕНО СВІДОМО (біллинг/реєстрація платформи: політика
// ламала signup і видачу ліцензій — див. PLATFORM_MANAGED у backend/lib/ensure-rls.js).
// Ізоляція там реалізована явними WHERE tenant_id=$1 у платформенному коді.
// Читаємо список З ФАЙЛУ, а не дублюємо: інакше сторож бреше після зміни коду.
function platformManaged() {
  try {
    const src = require('fs').readFileSync(path.join(BACKEND, 'lib', 'ensure-rls.js'), 'utf8');
    const m = src.match(/const PLATFORM_MANAGED = \[([\s\S]*?)\];/);
    if (!m) return [];
    return (m[1].match(/'([a-z0-9_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  } catch (_) { return []; }
}
const EXPECTED_NO_RLS = new Set(platformManaged());
// Таблиці, витік яких найдорожчий (гроші й персональні дані клієнтів).
const CRITICAL = ['appointments', 'clients', 'cash_operations', 'payments', 'payroll_records', 'orders'];

const problems = [];
const ok = [];

async function main() {
  const url = process.env.DATABASE_URL_APP || process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL не заданий'); process.exit(2); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // ── 1. роль app_tenant ───────────────────────────────────────────────────
  const role = await c.query('SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname=$1', [APP_ROLE]);
  if (!role.rows[0]) problems.push(`роль ${APP_ROLE} НЕ існує — ізоляція вимкнена повністю`);
  else if (role.rows[0].rolbypassrls) problems.push(`роль ${APP_ROLE} має BYPASSRLS — RLS не діє`);
  else ok.push(`роль ${APP_ROLE}: BYPASSRLS вимкнено`);

  // ── 2. RLS на всіх тенантських таблицях ──────────────────────────────────
  const tabs = await c.query(`
    SELECT co.table_name AS t, cl.relrowsecurity AS rls, cl.relforcerowsecurity AS force,
           (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = co.table_name)::int AS policies
      FROM information_schema.columns co
      JOIN pg_class cl ON cl.relname = co.table_name
     WHERE co.column_name = 'tenant_id' AND co.table_schema='public' AND cl.relkind='r'
     ORDER BY 1`);
  const unexpected = (arr) => arr.filter((t) => !EXPECTED_NO_RLS.has(t));
  const noRls = unexpected(tabs.rows.filter((r) => !r.rls).map((r) => r.t));
  const noPolicy = unexpected(tabs.rows.filter((r) => r.policies === 0).map((r) => r.t));
  // FORCE впливає лише на ВЛАСНИКА таблиці. Робочий пул ходить під app_tenant
  // (не власник), тож RLS діє й без FORCE — це попередження, а не витік.
  const noForce = unexpected(tabs.rows.filter((r) => r.rls && !r.force).map((r) => r.t));
  if (noRls.length) problems.push(`RLS ВИМКНЕНО (${noRls.length}): ${noRls.slice(0, 15).join(', ')}${noRls.length > 15 ? ' …' : ''}`);
  if (noPolicy.length) problems.push(`є tenant_id, але ЖОДНОЇ політики (${noPolicy.length}): ${noPolicy.slice(0, 15).join(', ')}${noPolicy.length > 15 ? ' …' : ''}`);
  // Колонка tenant_id не-uuid = таблиця випадає і з self-healing RLS, і з purge салона
  // (саме так branch_kpi_snapshots прожила без ізоляції — знайдено 26.07).
  const badType = await c.query(`SELECT table_name FROM information_schema.columns
     WHERE column_name='tenant_id' AND table_schema='public' AND data_type <> 'uuid'`);
  if (badType.rows.length) problems.push(`tenant_id НЕ uuid (випадає з RLS і purge): ${badType.rows.map((r) => r.table_name).join(', ')}`);
  ok.push(`тенантських таблиць: ${tabs.rows.length}, з RLS: ${tabs.rows.filter((r) => r.rls).length}, свідомих винятків платформи: ${EXPECTED_NO_RLS.size}`);
  if (noForce.length) ok.push(`попередження (не витік): RLS без FORCE на ${noForce.length} табл. — діє, бо пул ходить не власником`);

  // ── 3. бойовий тест витоку ───────────────────────────────────────────────
  const tenants = (await c.query('SELECT id, slug FROM tenants ORDER BY created_at LIMIT 12')).rows;
  const present = new Set(tabs.rows.map((r) => r.t));
  for (const t of tenants) {
    for (const tbl of CRITICAL.filter((x) => present.has(x))) {
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await c.query('SELECT set_config($1,$2,true)', ['app.tenant_id', t.id]);
        const r = await c.query(`SELECT COUNT(*)::int AS foreign_rows FROM ${tbl} WHERE tenant_id <> $1`, [t.id]);
        await c.query('ROLLBACK');
        const n = r.rows[0].foreign_rows;
        if (n > 0) problems.push(`ВИТІК: салон ${t.slug} бачить ${n} чужих рядків у ${tbl}`);
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        problems.push(`перевірка ${tbl} для ${t.slug} впала: ${e.message}`);
      }
    }
  }
  ok.push(`бойовий тест витоку: ${tenants.length} орендарів × ${CRITICAL.length} таблиць`);

  await c.end();

  console.log('── ІЗОЛЯЦІЯ ОРЕНДАРІВ ──');
  ok.forEach((s) => console.log('  [+] ' + s));
  if (!problems.length) { console.log('  РЕЗУЛЬТАТ: чисто, витоків не знайдено'); process.exit(0); }
  console.log('── ПРОБЛЕМИ ──');
  problems.forEach((s) => console.log('  [-] ' + s));
  process.exit(1);
}

main().catch((e) => { console.error('check failed:', e.message); process.exit(2); });
