/* lib/tenant-mgmt.js — SAS-06 Tenant Management.
   Платформенные операции суперадмина: дашборд тенантов, health-score из реальных
   метрик, онбординг, тикеты поддержки, usage. Таблицы без RLS (как saas_plans) —
   запросы фильтруют по tenant_id явно; для записи в чужой тенант указываем tenant_id. */
const { getPool } = require('../db-pg');
const { runAs } = require('./tenant');
const { hashPassword, normalizePhone } = require('./auth-core');
const billing = require('./billing');

// Роли нового салона (зеркало migration 008 — у каждого тенанта свои роли: RLS per-tenant).
const ROLE_SEED = [
  ['owner', 'Власник', 100, '["*"]'],
  ['admin', 'Адмін', 80, '["crm.*","shop.*","cashbox.*","reports.*","clients.*","masters.*","stock.*"]'],
  ['manager', 'Менеджер', 60, '["shop.read","shop.write","cashbox.read","cashbox.write","clients.*","reports.read","stock.read"]'],
  ['master', 'Майстер', 40, '["bookings.own","clients.read","cashbox.read.own","reports.own"]'],
  ['reception', 'Рецепшен', 30, '["bookings.*","clients.*","cashbox.in","shop.read"]'],
  ['readonly', 'Тільки читання', 10, '["*.read"]'],
];

// Транслитерация назви салону → slug (укр/рус → latin, безпечний для сабдомена).
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ie', ё: 'e', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia',
};
function slugify(name) {
  const base = String(name || '').toLowerCase()
    .split('').map(ch => TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'salon';
}
async function uniqueSlug(name) {
  const pool = getPool();
  const base = slugify(name);
  let slug = base, i = 1;
  // tenants — без RLS, читаем напрямую
  while ((await pool.query('SELECT 1 FROM tenants WHERE slug=$1', [slug])).rowCount) {
    i += 1; slug = `${base}-${i}`;
  }
  return slug;
}

// ── Создание салона (SAS-06): тенант + владелец + подписка с авто-сроком ──
// admin-managed онбординг. Возвращает данные для входа владельца.
async function createTenant(name, opts = {}, actor = null) {
  if (!name || !String(name).trim()) throw new Error('name-required');
  const phoneDigits = String(opts.phone || '').replace(/\D/g, '');
  // Зберігаємо телефон у каноні 380… без '+' (auth-core.normalizePhone, міграція 200) — логін шукає всі формати.
  const phone = phoneDigits ? normalizePhone(phoneDigits) : '';
  const password = opts.password ? String(opts.password) : null;
  // passwordHash — готовый хеш (путь верификации: pending хранит хеш, не открытый пароль).
  const presetHash = opts.passwordHash ? String(opts.passwordHash) : null;
  if (!phone) throw new Error('owner-phone-required');
  if (!presetHash && (!password || password.length < 6)) throw new Error('owner-password-required'); // >=6 для входа
  const planCode = opts.plan_code || 'pro';
  const cycle = opts.cycle === 'yearly' ? 'yearly' : 'monthly';
  const trial = opts.trial !== false; // по умолчанию trial 14д
  const ownerName = opts.owner_name || 'Власник';
  const email = opts.email || null;
  // Вертикаль (Phase A, 18.07): выбирается на signup. Невалидное значение → beauty
  // (CHECK в мигр. 272 всё равно не пропустит чужое — двойная защита).
  const businessType = ['beauty', 'fitness', 'dental', 'wellness'].includes(opts.business_type) ? opts.business_type : 'beauty';

  const pool = getPool();
  const slug = await uniqueSlug(name);
  // 1) Тенант. status=active (доступ открыт; платёжный статус живёт в subscription).
  const tenant = (await pool.query(
    `INSERT INTO tenants (name, slug, status, plan, country, lang, business_type) VALUES ($1,$2,'active',$3,$4,COALESCE($5,'uk'),$6) RETURNING *`,
    [String(name).trim(), slug, planCode, opts.country || null, opts.lang || null, businessType])).rows[0];

  // 2) Роли + владелец — в контексте нового тенанта (RLS WITH CHECK + DEFAULT tenant_id).
  // Критичная связка: без владельца салон = «мёртвый» (войти нельзя). Аудит: если этот шаг
  // упадёт, компенсируем — удаляем только что созданный tenant (+ его роли), чтобы не оставить
  // orphan-салон с зарезервированным slug и без входа. Шаги 3+ (сиды/подписка) уже в try/catch.
  const hash = presetHash || await hashPassword(password);
  let owner;
  try {
    owner = await runAs(tenant.id, async () => {
      for (const [code, rname, level, perms] of ROLE_SEED) {
        await pool.query(
          `INSERT INTO roles (code, name, level, permissions) VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (tenant_id, code) DO NOTHING`, [code, rname, level, perms]);
      }
      const roleId = (await pool.query(`SELECT id FROM roles WHERE code='owner' LIMIT 1`)).rows[0].id;
      return (await pool.query(
        `INSERT INTO users (phone, email, display_name, role_id, password_hash, is_active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id, phone, email, display_name`,
        [phone, email, ownerName, roleId, hash])).rows[0];
    });
  } catch (ownerErr) {
    console.error('[tenant-mgmt:createTenant:owner] откат orphan-tenant:', ownerErr.message);
    try {
      await pool.query(`DELETE FROM roles WHERE tenant_id=$1`, [tenant.id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE tenant_id=$1`, [tenant.id]).catch(() => {});
      await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenant.id]).catch(() => {});
    } catch (_) {}
    throw new Error('owner-creation-failed');
  }

  // 3) Подписка с авто-расчётом срока (trial 14д → monthly 30д / yearly 365д). RLS-free таблицы.
  let subscription = null;
  try {
    subscription = await billing.createSubscription(tenant.id, { plan_code: planCode, cycle, trial }, actor);
  } catch (e) { console.error('[tenant-mgmt:createTenant:sub]', e.message); }

  // 4) Товарні категорії — стандартний набір з правильним commissionable (SaaS-аудит 06.07:
  //    новий салон стартував із порожніми категоріями → фарби/окисники давали % майстру,
  //    склад без груп). Фарби/окисники/знебарвлення/завивка/пігменти = розхідник (commissionable=FALSE).
  try { await seedTenantCategories(tenant.id); } catch (e) { console.error('[tenant-mgmt:createTenant:cats]', e.message); }

  // 4b) Стадії пайплайна візитів — з 251 вони per-tenant; без сіду канбан журналу порожній.
  try { await seedTenantPipelineStages(tenant.id); } catch (e) { console.error('[tenant-mgmt:createTenant:pipeline]', e.message); }

  // 4c) KPI-метрики, GC-шаблон, winback-цепочка — SQL-функция из 252 (единый источник сида).
  //     runAs обязателен: kpi_metrics и др. под RLS WITH CHECK — из платформенного контекста
  //     (public signup / адмінка) сид мовчки відхилявся, новий салон лишався без KPI (баг 13.07).
  try { await runAs(tenant.id, () => getPool().query(`SELECT seed_tenant_defaults($1)`, [tenant.id])); } catch (e) { console.error('[tenant-mgmt:createTenant:defaults]', e.message); }

  // 5) Онбординг: шаг registration выполнен.
  try { await completeStep(tenant.id, 'registration'); } catch (_) {}

  return {
    tenant, slug,
    owner: { id: owner.id, phone: owner.phone, display_name: owner.display_name },
    subscription: subscription ? {
      plan_code: subscription.plan_code, status: subscription.status,
      billing_cycle: subscription.billing_cycle,
      current_period_end: subscription.current_period_end,
      trial_ends_at: subscription.trial_ends_at,
    } : null,
    login: { tenant_slug: slug, phone, header: 'X-Tenant-Slug: ' + slug },
  };
}

// ── Health score ─────────────────────────────────────────────────────
// 0-100 из доступных реальных сигналов. Категория: healthy(70+)/warning(40-69)/critical(<40).
function categorize(score) {
  return score >= 70 ? 'healthy' : score >= 40 ? 'warning' : 'critical';
}

// Считаем метрики тенанта напрямую из боевых таблиц (cross-tenant: фильтр по $1).
async function computeHealth(tenantId) {
  const pool = getPool();
  const one = async (sql) => (await pool.query(sql, [tenantId])).rows[0] || {};
  const m = {};
  m.clients = Number((await one(`SELECT count(*)::int n FROM clients WHERE tenant_id=$1`)).n || 0);
  m.appointments_7d = Number((await one(
    `SELECT count(*)::int n FROM appointments WHERE tenant_id=$1 AND created_at >= NOW()-INTERVAL '7 days'`)).n || 0);
  m.appointments_30d = Number((await one(
    `SELECT count(*)::int n FROM appointments WHERE tenant_id=$1 AND created_at >= NOW()-INTERVAL '30 days'`)).n || 0);
  m.masters = Number((await one(
    `SELECT count(*)::int n FROM masters WHERE tenant_id=$1 AND COALESCE(active,true)=true`)).n || 0);
  // заполненность профиля салона (white_label_configs / tenants.settings)
  const t = await one(`SELECT name, slug, settings FROM tenants WHERE id=$1`);
  let profile = 0;
  if (t.name) profile += 40;
  if (t.slug) profile += 20;
  if (t.settings && Object.keys(t.settings).length) profile += 40;
  m.profile_completeness = profile;

  // скоринг: активность записей (40) + база клиентов (20) + мастера (20) + профиль (20)
  const sAppt = Math.min(40, m.appointments_7d * 4);                 // 10+ записей/нед = max
  const sClients = Math.min(20, Math.floor(m.clients / 25) * 5);      // 100+ клиентов = max
  const sMasters = m.masters > 0 ? Math.min(20, m.masters * 5) : 0;   // 4+ мастера = max
  const sProfile = Math.round(profile * 0.2);                         // профиль → 20
  const score = Math.max(0, Math.min(100, sAppt + sClients + sMasters + sProfile));
  return { score, category: categorize(score), metrics: m };
}

// Записать health-чек в историю (для cron каждые 6ч).
async function runHealthCheck(tenantId) {
  const pool = getPool();
  const { score, category, metrics } = await computeHealth(tenantId);
  const prev = (await pool.query(
    `SELECT health_score FROM tenant_health_checks WHERE tenant_id=$1 ORDER BY check_date DESC LIMIT 1`, [tenantId])).rows[0];
  const previousScore = prev ? prev.health_score : null;
  const alerts = [];
  if (previousScore != null && previousScore - score > 20)
    alerts.push({ type: 'score_drop', severity: 'high', message: `Health впав на ${previousScore - score} за період` });
  const row = (await pool.query(
    `INSERT INTO tenant_health_checks (tenant_id, health_score, category, metrics, alerts, previous_score)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenantId, score, category, JSON.stringify(metrics), JSON.stringify(alerts), previousScore])).rows[0];
  return row;
}

async function runHealthAll() {
  const tenants = (await getPool().query(`SELECT id FROM tenants WHERE status='active'`)).rows;
  let checked = 0;
  for (const t of tenants) { try { await runHealthCheck(t.id); checked++; } catch (e) { console.error('[tenant-mgmt] health', t.id, e.message); } }
  return { tenants: tenants.length, checked };
}

// ── Дашборд / список / детали ────────────────────────────────────────
async function dashboard() {
  const pool = getPool();
  const byStatus = (await pool.query(`SELECT status, count(*)::int n FROM tenants GROUP BY status`)).rows;
  const status = {}; byStatus.forEach(r => status[r.status] = r.n);
  const total = Object.values(status).reduce((a, b) => a + b, 0);
  // последний health по каждому тенанту → распределение по категориям
  const health = (await pool.query(
    `SELECT category, count(*)::int n FROM (
       SELECT DISTINCT ON (tenant_id) tenant_id, category
       FROM tenant_health_checks ORDER BY tenant_id, check_date DESC
     ) x GROUP BY category`)).rows;
  const healthOverview = {}; health.forEach(r => healthOverview[r.category] = r.n);
  const openTickets = Number((await pool.query(
    `SELECT count(*)::int n FROM tenant_support_tickets WHERE status IN ('open','in_progress')`)).rows[0].n);
  return {
    total, active: status.active || 0, trial: status.trial || status.trialing || 0,
    suspended: status.suspended || 0, by_status: status,
    health_overview: healthOverview, open_tickets: openTickets,
  };
}

async function listTenants({ status = null, search = null, limit = 50, offset = 0 } = {}) {
  const pool = getPool();
  const where = [], params = []; let i = 1;
  if (status) { where.push(`t.status=$${i++}`); params.push(status); }
  if (search) { where.push(`(t.name ILIKE $${i} OR t.slug ILIKE $${i})`); params.push('%' + search + '%'); i++; }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const rows = (await pool.query(
    `SELECT t.id, t.name, t.slug, t.status, t.plan, t.created_at,
            l.plan_code, l.status AS license_status,
            h.health_score, h.category AS health_category
       FROM tenants t
       LEFT JOIN tenant_licenses l ON l.tenant_id=t.id
       LEFT JOIN LATERAL (SELECT health_score, category FROM tenant_health_checks
                          WHERE tenant_id=t.id ORDER BY check_date DESC LIMIT 1) h ON true
       ${ws} ORDER BY t.created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows;
  const total = Number((await pool.query(`SELECT count(*)::int n FROM tenants t ${ws}`, params.slice(0, where.length))).rows[0].n);
  return { rows, total };
}

async function tenantDetail(tenantId) {
  const pool = getPool();
  const t = (await pool.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (!t) return null;
  const lic = (await pool.query(`SELECT * FROM tenant_licenses WHERE tenant_id=$1`, [tenantId])).rows[0] || null;
  const onb = (await pool.query(`SELECT * FROM tenant_onboarding WHERE tenant_id=$1`, [tenantId])).rows[0] || null;
  const health = await computeHealth(tenantId);
  const tickets = Number((await pool.query(
    `SELECT count(*)::int n FROM tenant_support_tickets WHERE tenant_id=$1 AND status IN ('open','in_progress')`, [tenantId])).rows[0].n);
  return { tenant: t, license: lic, onboarding: onb, health, open_tickets: tickets };
}

// ── Повний профіль підписника (картка салону в панелі SaaS) ──────────
// Все про один салон: підписка, рахунки, платежі, ліцензія з індивідуальними
// overrides (фічі + ліміти), історія планів, використання лімітів, власник.
const LEGACY_PLAN_SLUG = { solo: 'free', pro: 'professional' };
async function tenantProfile(tenantId) {
  const pool = getPool();
  const t = (await pool.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (!t) return null;
  const q = (sql, params) => pool.query(sql, params).then(r => r.rows).catch(() => []);
  const [licR, subR, invoices, payments, changes, addons, flags, onbR, ownerR] = await Promise.all([
    q(`SELECT * FROM tenant_licenses WHERE tenant_id=$1`, [tenantId]),
    q(`SELECT * FROM subscriptions_saas WHERE tenant_id=$1`, [tenantId]),
    q(`SELECT id, invoice_number, status, subtotal, discount_amount, total, due_date, period_start, period_end, created_at
         FROM invoices_saas WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 15`, [tenantId]),
    q(`SELECT id, invoice_id, amount, status, gateway, created_at
         FROM payments_saas WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 15`, [tenantId]),
    q(`SELECT c.action, c.prorated_uah, c.created_at, pf.slug AS from_plan, pt.slug AS to_plan
         FROM plan_change_log c
         LEFT JOIN saas_plans_v2 pf ON pf.id=c.from_plan_id
         LEFT JOIN saas_plans_v2 pt ON pt.id=c.to_plan_id
        WHERE c.tenant_id=$1 ORDER BY c.created_at DESC LIMIT 10`, [tenantId]),
    q(`SELECT a.slug, a.addon_type, ta.status, ta.cycle
         FROM tenant_plan_addons ta JOIN plan_addons a ON a.id=ta.addon_id
        WHERE ta.tenant_id=$1`, [tenantId]),
    q(`SELECT key, name, description, default_enabled FROM feature_flags ORDER BY key`),
    q(`SELECT * FROM tenant_onboarding WHERE tenant_id=$1`, [tenantId]),
    q(`SELECT u.display_name, u.phone, u.email, u.last_login_at
         FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active=TRUE
        ORDER BY u.id LIMIT 1`, [tenantId]),
  ]);
  const lic = licR[0] || null;
  // Ліміти тарифу цього салону (щоб показати «за тарифом N» поряд з override)
  const planLimits = lic ? await q(
    `SELECT pl.limit_key, pl.limit_value, pl.is_soft
       FROM saas_plans_v2 p JOIN plan_limits pl ON pl.plan_id=p.id
      WHERE p.slug = COALESCE($2::jsonb->>$1, $1)`,
    [lic.plan_code, JSON.stringify(LEGACY_PLAN_SLUG)]) : [];
  // Реальне використання (під RLS-контекстом салону)
  let usage = null;
  try {
    usage = await runAs(tenantId, async () => {
      const one = async (sql) => Number((await pool.query(sql)).rows[0]?.n) || 0;
      return {
        masters: await one(`SELECT COUNT(*)::int n FROM masters WHERE COALESCE(active,true)=true`),
        clients: await one(`SELECT COUNT(*)::int n FROM clients`),
        appointments_30d: await one(`SELECT COUNT(*)::int n FROM appointments WHERE starts_at > NOW() - interval '30 days'`),
      };
    });
  } catch { usage = null; }
  const health = await computeHealth(tenantId).catch(() => null);
  const openTickets = Number((await pool.query(
    `SELECT count(*)::int n FROM tenant_support_tickets WHERE tenant_id=$1 AND status IN ('open','in_progress')`,
    [tenantId])).rows[0].n);
  return {
    tenant: t, license: lic, subscription: subR[0] || null,
    invoices, payments, plan_changes: changes, addons, flags,
    plan_limits: planLimits, usage, health,
    onboarding: onbR[0] || null, owner: ownerR[0] || null, open_tickets: openTickets,
    platform_notes: (t.settings && t.settings.platform_notes) || '',
  };
}

// Редагування тенанта оператором платформи: назва + службові нотатки (в settings)
async function updateTenant(tenantId, { name, notes } = {}) {
  const pool = getPool();
  const t = (await pool.query(`SELECT id FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (!t) throw new Error('tenant-not-found');
  if (name !== undefined && String(name).trim())
    await pool.query(`UPDATE tenants SET name=$2, updated_at=NOW() WHERE id=$1`, [tenantId, String(name).trim().slice(0, 120)]);
  if (notes !== undefined)
    await pool.query(
      `UPDATE tenants SET settings=COALESCE(settings,'{}'::jsonb)||jsonb_build_object('platform_notes',$2::text), updated_at=NOW() WHERE id=$1`,
      [tenantId, String(notes).slice(0, 5000)]);
  return (await pool.query(`SELECT id, name, status, settings FROM tenants WHERE id=$1`, [tenantId])).rows[0];
}

// Індивідуальна ліцензія салону: статус/строки + overrides фіч ({key:bool})
// і лімітів ({"limit:<key>": число}). null/'' у значенні = прибрати override (за тарифом).
// План тут НЕ міняємо — зміна тарифу йде через billing override (щоб підписка й ліцензія не розійшлися).
async function setLicense(tenantId, { status, trial_ends_at, expires_at, feature_overrides, limit_overrides } = {}) {
  const pool = getPool();
  if (status && !['active', 'trial', 'suspended', 'cancelled'].includes(status)) throw new Error('status-invalid');
  const cur = (await pool.query(`SELECT * FROM tenant_licenses WHERE tenant_id=$1`, [tenantId])).rows[0];
  const overrides = Object.assign({}, (cur && cur.overrides) || {});
  if (feature_overrides && typeof feature_overrides === 'object')
    for (const [k, v] of Object.entries(feature_overrides)) {
      if (v === null || v === 'inherit') delete overrides[k]; else overrides[k] = !!v;
    }
  if (limit_overrides && typeof limit_overrides === 'object')
    for (const [k, v] of Object.entries(limit_overrides)) {
      const key = 'limit:' + String(k).replace(/[^a-z0-9_]/gi, '');
      if (v === null || v === '' || !Number.isFinite(Number(v))) delete overrides[key];
      else overrides[key] = Math.max(-1, Math.round(Number(v)));
    }
  const r = (await pool.query(
    `INSERT INTO tenant_licenses (tenant_id, plan_code, status, trial_ends_at, expires_at, overrides, updated_at)
     VALUES ($1, 'solo', COALESCE($2,'active'), $3, $4, $5::jsonb, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       status        = COALESCE($2, tenant_licenses.status),
       trial_ends_at = CASE WHEN $6 THEN $3 ELSE tenant_licenses.trial_ends_at END,
       expires_at    = CASE WHEN $7 THEN $4 ELSE tenant_licenses.expires_at END,
       overrides     = $5::jsonb, updated_at = NOW()
     RETURNING *`,
    [tenantId, status || null, trial_ends_at || null, expires_at || null, JSON.stringify(overrides),
     trial_ends_at !== undefined, expires_at !== undefined])).rows[0];
  return r;
}

// Подарувати дні: продовжити оплачений період підписки + строки ліцензії.
// Компенсація за збій, бонус за лояльність, продовження тріалу — все одним рухом.
async function giftDays(tenantId, days, reason = null) {
  const d = Math.round(Number(days));
  if (!d || d < 1 || d > 730) throw new Error('days-invalid (1..730)');
  const pool = getPool();
  const sub = (await pool.query(
    `UPDATE subscriptions_saas
        SET current_period_end = GREATEST(COALESCE(current_period_end, NOW()), NOW()) + make_interval(days => $2),
            trial_ends_at = CASE WHEN status='trialing'
              THEN GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + make_interval(days => $2)
              ELSE trial_ends_at END,
            updated_at = NOW()
      WHERE tenant_id=$1 RETURNING *`, [tenantId, d])).rows[0] || null;
  await pool.query(
    `UPDATE tenant_licenses
        SET expires_at    = CASE WHEN expires_at    IS NULL THEN NULL ELSE GREATEST(expires_at, NOW())    + make_interval(days => $2) END,
            trial_ends_at = CASE WHEN trial_ends_at IS NULL THEN NULL ELSE GREATEST(trial_ends_at, NOW()) + make_interval(days => $2) END,
            updated_at = NOW()
      WHERE tenant_id=$1`, [tenantId, d]).catch(() => {});
  await pool.query(
    `UPDATE tenant_onboarding SET notes=COALESCE(notes,'')||$2, updated_at=NOW() WHERE tenant_id=$1`,
    [tenantId, `\n[${new Date().toISOString().slice(0, 10)}] Подаровано +${d} дн.${reason ? ' — ' + String(reason).slice(0, 200) : ''}`]).catch(() => {});
  return { subscription: sub, days: d };
}

async function setStatus(tenantId, status, reason = null) {
  const pool = getPool();
  const r = (await pool.query(
    `UPDATE tenants SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING id, name, status`, [tenantId, status])).rows[0];
  if (!r) throw new Error('tenant-not-found');
  if (reason) await pool.query(
    `UPDATE tenant_onboarding SET notes=COALESCE(notes,'')||$2, updated_at=NOW() WHERE tenant_id=$1`,
    [tenantId, `\n[${new Date().toISOString()}] ${status}: ${reason}`]).catch(() => {});
  return r;
}

// ── Онбординг ────────────────────────────────────────────────────────
const ONB_STEPS = ['registration', 'profile', 'services', 'employees', 'first_booking'];

// Стандартний набір товарних категорій. commissionable=FALSE → розхідник (% з продажу не дає).
const DEFAULT_CATEGORIES = [
  ['coloring', 'Фарби', 'Фарбування', false], ['oxidant', 'Окисники', 'Фарбування', false],
  ['bleach', 'Знебарвлення', 'Фарбування', false], ['pigment', 'Пігменти', 'Фарбування', false],
  ['perm', 'Завивка', 'Професійне', false],
  ['shampoo', 'Шампуні', 'Миття та догляд', true], ['conditioner', 'Кондиціонери', 'Миття та догляд', true],
  ['mask', 'Маски', 'Миття та догляд', true], ['ampoules', 'Ампули', 'Лікування', true],
  ['keratin', 'Кератин', 'Лікування', true], ['repair', 'Реконструкція', 'Лікування', true],
  ['scalp', 'Шкіра голови', 'Лікування', true], ['lotion', 'Лосьйони', 'Лікування', true],
  ['serum', 'Сироватки', 'Незмивний догляд', true], ['oil', 'Олії', 'Незмивний догляд', true],
  ['cream', 'Креми', 'Незмивний догляд', true], ['fluid', 'Флюїди', 'Незмивний догляд', true],
  ['spray', 'Спреї', 'Незмивний догляд', true], ['thermal', 'Термозахисти', 'Незмивний догляд', true],
  ['care', 'Догляд', 'Незмивний догляд', true], ['styling', 'Стайлінг', 'Професійне', true],
  ['toning', 'Тонуючі маски', 'Тонування', true], ['set', 'Набори', 'Набори', true],
  ['tools', 'Інструменти', 'Професійне', true], ['accessory', 'Аксесуари', 'Професійне', true],
];
async function seedTenantCategories(tenantId) {
  const pool = getPool();
  await runAs(tenantId, async () => {
    for (const [id, name, group_name, comm] of DEFAULT_CATEGORIES) {
      await pool.query(
        `INSERT INTO categories (id, name, group_name, commissionable)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, id) DO NOTHING`,
        [id, name, group_name, comm]);
    }
  });
}

// Базові стадії пайплайна візитів (дзеркало сіда міграцій 155/251)
const DEFAULT_PIPELINE_STAGES = [
  ['booked',      'Заплановані',  0, '#6366f1', 1440, false],
  ['confirmed',   'Підтверджені', 1, '#0ea5e9', 120,  false],
  ['arrived',     'Прийшли',      2, '#f59e0b', 15,   false],
  ['in_progress', 'В роботі',     3, '#8b5cf6', null, false],
  ['done',        'Завершені',    4, '#16a34a', null, true],
  ['noshow',      'Не прийшли',   5, '#dc2626', null, true],
  ['cancelled',   'Скасовані',    6, '#94a3b8', null, true],
];
async function seedTenantPipelineStages(tenantId) {
  const pool = getPool();
  await runAs(tenantId, async () => {
    for (const [code, name, position, color, sla, terminal] of DEFAULT_PIPELINE_STAGES) {
      await pool.query(
        `INSERT INTO visit_pipeline_stages (code, name, position, color, sla_minutes, is_terminal)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [code, name, position, color, sla, terminal]);
    }
  });
}

async function getOnboarding(tenantId) {
  const pool = getPool();
  let row = (await pool.query(`SELECT * FROM tenant_onboarding WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (!row) row = (await pool.query(
    `INSERT INTO tenant_onboarding (tenant_id) VALUES ($1)
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at=NOW() RETURNING *`, [tenantId])).rows[0];
  return row;
}

async function completeStep(tenantId, step) {
  if (!ONB_STEPS.includes(step)) throw new Error('invalid-step');
  const pool = getPool();
  const o = await getOnboarding(tenantId);
  // соло-майстер працює сам → крок 'employees' не потрібен, інакше 100% недосяжні (SaaS-аудит 06.07)
  const required = (o.account_type === 'solo') ? ONB_STEPS.filter(s => s !== 'employees') : ONB_STEPS;
  const done = new Set(o.steps_completed || []); done.add(step);
  const arr = required.filter(s => done.has(s));
  const percent = Math.round((arr.length / required.length) * 100);
  const completed = percent === 100;
  const curStep = Math.min(required.length, arr.length + (completed ? 0 : 1));
  const row = (await pool.query(
    `UPDATE tenant_onboarding SET steps_completed=$2, completion_percent=$3, current_step=$4,
       completed_at=CASE WHEN $5 THEN COALESCE(completed_at,NOW()) ELSE NULL END, updated_at=NOW()
     WHERE tenant_id=$1 RETURNING *`,
    [tenantId, JSON.stringify(arr), percent, curStep, completed])).rows[0];
  return row;
}

async function updateOnboarding(tenantId, patch = {}) {
  await getOnboarding(tenantId);
  const cols = [], vals = []; let i = 1;
  if (patch.assigned_csm !== undefined) { cols.push(`assigned_csm=$${i++}`); vals.push(patch.assigned_csm); }
  if (patch.notes !== undefined) { cols.push(`notes=$${i++}`); vals.push(patch.notes); }
  if (!cols.length) return getOnboarding(tenantId);
  cols.push('updated_at=NOW()'); vals.push(tenantId);
  return (await getPool().query(
    `UPDATE tenant_onboarding SET ${cols.join(', ')} WHERE tenant_id=$${i} RETURNING *`, vals)).rows[0];
}

// ── Тикеты поддержки ─────────────────────────────────────────────────
async function nextTicketNumber() {
  const n = Number((await getPool().query(`SELECT nextval('tenant_support_tickets_id_seq') AS v`)).rows[0].v);
  return 'TKT-' + String(n).padStart(6, '0');
}

async function createTicket(tenantId, b = {}, user = null) {
  if (!b.subject || !b.description) throw new Error('subject-and-description-required');
  const num = await nextTicketNumber();
  const row = (await getPool().query(
    `INSERT INTO tenant_support_tickets (tenant_id, ticket_number, subject, description, category, priority, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, num, b.subject, b.description, b.category || 'question', b.priority || 'medium',
     user?.id || null, user?.name || user?.username || null])).rows[0];
  return row;
}

async function listTickets({ tenantId = null, status = null, priority = null, assigned = null, limit = 50, offset = 0 } = {}) {
  const where = [], params = []; let i = 1;
  if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
  if (status) { where.push(`status=$${i++}`); params.push(status); }
  if (priority) { where.push(`priority=$${i++}`); params.push(priority); }
  if (assigned) { where.push(`assigned_to=$${i++}`); params.push(assigned); }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const rows = (await getPool().query(
    `SELECT * FROM tenant_support_tickets ${ws} ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows;
  return { rows };
}

async function getTicket(id, { includeInternal = true } = {}) {
  const pool = getPool();
  const t = (await pool.query(`SELECT * FROM tenant_support_tickets WHERE id=$1`, [id])).rows[0];
  if (!t) return null;
  const replies = (await pool.query(
    `SELECT * FROM ticket_replies WHERE ticket_id=$1 ${includeInternal ? '' : 'AND internal=false'} ORDER BY created_at`, [id])).rows;
  return { ticket: t, replies };
}

async function updateTicket(id, patch = {}) {
  const cols = [], vals = []; let i = 1;
  for (const k of ['status', 'priority', 'assigned_to', 'internal_notes']) {
    if (patch[k] !== undefined) { cols.push(`${k}=$${i++}`); vals.push(patch[k]); }
  }
  if (patch.status === 'resolved') cols.push('resolved_at=COALESCE(resolved_at,NOW())');
  if (patch.status === 'closed') cols.push('closed_at=COALESCE(closed_at,NOW())');
  if (!cols.length) return null;
  cols.push('updated_at=NOW()'); vals.push(id);
  return (await getPool().query(
    `UPDATE tenant_support_tickets SET ${cols.join(', ')} WHERE id=$${i} RETURNING *`, vals)).rows[0] || null;
}

async function replyTicket(id, { message, internal = false, isStaff = false, user = null } = {}) {
  if (!message) throw new Error('message-required');
  const pool = getPool();
  const reply = (await pool.query(
    `INSERT INTO ticket_replies (ticket_id, author_id, author_name, is_staff, internal, message)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, user?.id || null, user?.name || user?.username || null, isStaff, internal, message])).rows[0];
  // первый ответ персонала → first_response_at; статус → in_progress
  if (isStaff && !internal) await pool.query(
    `UPDATE tenant_support_tickets SET first_response_at=COALESCE(first_response_at,NOW()),
       status=CASE WHEN status='open' THEN 'in_progress' ELSE status END, updated_at=NOW() WHERE id=$1`, [id]);
  return reply;
}

async function supportStats() {
  const pool = getPool();
  const open = Number((await pool.query(`SELECT count(*)::int n FROM tenant_support_tickets WHERE status IN ('open','in_progress')`)).rows[0].n);
  const resp = (await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (first_response_at-created_at))/3600)::numeric(10,1) h
       FROM tenant_support_tickets WHERE first_response_at IS NOT NULL`)).rows[0];
  const resolv = (await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600)::numeric(10,1) h
       FROM tenant_support_tickets WHERE resolved_at IS NOT NULL`)).rows[0];
  const byStatus = (await pool.query(`SELECT status, count(*)::int n FROM tenant_support_tickets GROUP BY status`)).rows;
  const st = {}; byStatus.forEach(r => st[r.status] = r.n);
  return { open, avg_first_response_h: Number(resp.h) || 0, avg_resolution_h: Number(resolv.h) || 0, by_status: st };
}

// ── GDPR оффбординг: повне видалення даних салону при уході ───────────
// Незворотнє. Захист: (1) лише платформа (гард роуту), (2) салон має бути
// cancelled/suspended (не активний), (3) точна назва-підтвердження, (4) НЕ
// платформений тенант. Рекомендація: спершу /backup/export (портативність ПД).
// Видаляє рядки з УСІХ таблиць, що мають tenant_id (виявляє динамічно, нічого не
// пропустить), у кілька проходів через SAVEPOINT — коректний порядок FK без суперюзера.
async function purgeTenant(tenantId, { confirmName } = {}, actor = null) {
  const pool = getPool();
  const qi = (t) => '"' + String(t).replace(/"/g, '""') + '"';
  const t = (await pool.query(
    `SELECT id, name, status, COALESCE(is_internal, false) AS is_internal FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (!t) throw new Error('tenant-not-found');
  if (t.is_internal) throw new Error('cannot-purge-platform-tenant');
  if (!['cancelled', 'suspended'].includes(t.status)) throw new Error('tenant-must-be-cancelled-or-suspended-first');
  if (!confirmName || String(confirmName).trim() !== t.name) throw new Error('confirm-name-mismatch');

  // ЛИШЕ uuid-колонки: у branch_kpi_snapshots tenant_id INTEGER (інша семантика) —
  // DELETE ... WHERE tenant_id=<uuid> кидав 22P02 і валив увесь purge (E2E-аудит 10.07)
  const tbls = (await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' AND data_type='uuid'
        AND table_name <> 'tenants'`)).rows.map(r => r.table_name);

  // S3-файлы салона (аудит-контроль GDPR): портфолио, аватары мастеров, фото услуг/товаров.
  // Собираем ключи ДО удаления строк (под явным фильтром tenant_id — purge идёт от платформы),
  // удаляем из облака в фоне ПОСЛЕ успешного purge, иначе файлы салона живут вечно.
  let s3keys = [];
  try {
    const s3 = require('./s3-upload');
    if (s3.isConfigured()) {
      const c3 = s3._cfg();
      const urlToKey = (u) => {
        try { const p = new URL(u).pathname; const m = '/' + c3.bucket + '/'; const i = p.indexOf(m);
          if (i < 0) return null; let k = decodeURIComponent(p.slice(i + m.length));
          if (c3.prefix && k.startsWith(c3.prefix)) k = k.slice(c3.prefix.length); return k; } catch (_) { return null; }
      };
      const collect = async (sql) => { try { const r = await pool.query(sql, [tenantId]); for (const row of r.rows)
        for (const u of Object.values(row)) { if (typeof u === 'string' && /^https?:/.test(u)) { const k = urlToKey(u); if (k) s3keys.push(k); }
          else if (Array.isArray(u)) for (const uu of u) { if (typeof uu === 'string') { const k = urlToKey(uu); if (k) s3keys.push(k); } } } } catch (_) {} };
      await collect(`SELECT before_url, after_url, photo_urls FROM portfolio_items WHERE tenant_id=$1`);
      await collect(`SELECT avatar FROM masters WHERE tenant_id=$1`);
      await collect(`SELECT photo_urls FROM services WHERE tenant_id=$1`);
      await collect(`SELECT photo FROM products WHERE tenant_id=$1`);
      s3keys = Array.from(new Set(s3keys.filter(Boolean)));
    }
  } catch (_) {}

  const client = await pool.connect();
  const deleted = {};
  try {
    await client.query('BEGIN');
    let remaining = [...tbls];
    for (let pass = 0; pass < 10 && remaining.length; pass++) {
      const next = [];
      for (const tb of remaining) {
        await client.query('SAVEPOINT sp');
        try {
          const r = await client.query(`DELETE FROM ${qi(tb)} WHERE tenant_id=$1`, [tenantId]);
          deleted[tb] = (deleted[tb] || 0) + r.rowCount;
          await client.query('RELEASE SAVEPOINT sp');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          if (/foreign key|violates|depends/i.test(e.message)) next.push(tb); // спробуємо наступним проходом
          else throw e;
        }
      }
      if (next.length === remaining.length) throw new Error('fk-cycle, не видалились: ' + next.join(', '));
      remaining = next;
    }
    // платформені рядки, що посилаються на тенант
    for (const pt of ['subscriptions_saas', 'invoices_saas', 'tenant_addon_subscriptions', 'licenses', 'tenant_onboarding']) {
      await client.query('SAVEPOINT sp2');
      try { await client.query(`DELETE FROM ${qi(pt)} WHERE tenant_id=$1`, [tenantId]); await client.query('RELEASE SAVEPOINT sp2'); }
      catch (_) { await client.query('ROLLBACK TO SAVEPOINT sp2'); }
    }
    await client.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  // Файлы салона из S3 — фоном после успешного purge (best-effort, не блокирует ответ)
  if (s3keys.length) {
    const s3 = require('./s3-upload');
    setImmediate(() => Promise.allSettled(s3keys.map(k => s3.deleteObject(k)))
      .then(rs => console.log(`[tenant-mgmt:purge:s3] tenant=${tenantId} файлів видалено: ${rs.filter(x => x.status === 'fulfilled').length}/${s3keys.length}`)));
  }
  const totalRows = Object.values(deleted).reduce((s, n) => s + n, 0);
  console.log(`[tenant-mgmt:purge] tenant=${tenantId} name="${t.name}" by=${actor && actor.id || '?'} tables=${Object.keys(deleted).length} rows=${totalRows} s3files=${s3keys.length}`);
  return { purged: tenantId, name: t.name, tables_cleared: Object.keys(deleted).length, rows_deleted: totalRows, detail: deleted };
}

module.exports = {
  computeHealth, runHealthCheck, runHealthAll, categorize,
  dashboard, listTenants, tenantDetail, tenantProfile, updateTenant, setLicense, giftDays, setStatus, createTenant, purgeTenant,
  getOnboarding, completeStep, updateOnboarding, ONB_STEPS,
  createTicket, listTickets, getTicket, updateTicket, replyTicket, supportStats,
};
