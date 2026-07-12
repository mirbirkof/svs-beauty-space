/* ═══════════════════════════════════════════════════════════════════
   SAS-04 Plans & Pricing v2
   Монтується як /api/v2 → покриває:
     /api/v2/public/plans/…    (анонімний доступ, pricing page)
     /api/v2/public/addons
     /api/v2/tenant/plan/…     (поточний план тенанта, recommend, upgrade-preview)
     /api/v2/tenant/addons/…   (підключення/відключення add-ons)
     /api/v2/admin/plans/…     (суперадмін: каталог, features, limits, tenants)
     /api/v2/admin/addons/…

   Каталог: saas_plans_v2 + plan_features + plan_limits + plan_addons
            (нова UUID-лінійка, легасі saas_plans з 095 не чіпається).
   Лімітів enforcement: GET /tenant/plan повертає usage vs limit + headroom.
   Apgrade/downgrade: prorated-розрахунок + plan_change_log історія.
   Реальна оплата add-ons — graceful-стаб (pay-gateway optional через billing).

   Права (RBAC SAS-04):
     plans.public.read     → public (анонім)
     plans.tenant.read     → tenant_owner/admin, superadmin  (saas.read)
     plans.addons.manage   → tenant_owner, superadmin        (saas.read + tenant ctx)
     plans.manage/*.manage → superadmin                      (requirePlatform)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();
const { getPool }                      = require('../db-pg');
const { requirePerm, requirePlatform, logAction } = require('../lib/rbac');

const pool = getPool();
const q    = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/* ── helpers ─────────────────────────────────────────────────────── */

function err500(res, e) {
  console.error('[plans]', e.message);
  const msg = process.env.NODE_ENV === 'production' ? 'internal_error' : e.message;
  return res.status(500).json({ error: msg });
}

const CURRENCIES = ['UAH', 'USD', 'EUR'];

// Вибрати ціну в потрібній валюті з рядка плану.
function pricesFor(plan, currency) {
  const cur = CURRENCIES.includes(String(currency || '').toUpperCase())
    ? String(currency).toUpperCase() : 'UAH';
  const lc = cur.toLowerCase();
  const monthly = Number(plan[`price_monthly_${lc}`] || 0);
  const yearly  = Number(plan[`price_yearly_${lc}`] || 0);
  // Економія за рік відносно 12 місяців.
  const yearlySaving = monthly > 0 ? Math.max(0, monthly * 12 - yearly) : 0;
  const yearlySavingPct = monthly > 0 ? Math.round((yearlySaving / (monthly * 12)) * 100) : 0;
  return { currency: cur, monthly, yearly, yearly_saving: yearlySaving, yearly_saving_pct: yearlySavingPct };
}

// Тенант поточного запиту.
// ВАЖЛИВО: tenantMiddleware виставляє req.tenant_id (snake_case), а НЕ req.tenantId.
// Раніше читалося лише camelCase → для будь-якого салону крім Боса tenant=null,
// план/ліміти/usage рахувалися невірно. Читаємо req.tenant_id першим.
function tenantOf(req) {
  return req.tenant_id || req.tenantId || req.user?.tenant_id || null;
}

// Зібрати features+limits плану.
async function planDetail(planId, currency) {
  const plan = (await q(`SELECT * FROM saas_plans_v2 WHERE id=$1`, [planId]))[0];
  if (!plan) return null;
  const [features, limits] = await Promise.all([
    q(`SELECT feature_key, enabled, metadata FROM plan_features WHERE plan_id=$1 ORDER BY feature_key`, [planId]),
    q(`SELECT limit_key, limit_value, is_soft FROM plan_limits WHERE plan_id=$1 ORDER BY limit_key`, [planId]),
  ]);
  return { ...plan, prices: pricesFor(plan, currency), features, limits };
}

// Поточний план тенанта (через legacy tenant_licenses.plan_code → slug),
// з fallback на free. Повертає рядок saas_plans_v2 або null.
async function currentTenantPlan(tenantId) {
  // tenant_licenses.plan_code зберігає slug/code легасі-плану; мапимо на v2 за slug.
  const lic = tenantId
    ? (await q(`SELECT plan_code, status, trial_ends_at, expires_at
                  FROM tenant_licenses WHERE tenant_id=$1 LIMIT 1`, [tenantId]))[0]
    : null;
  let slug = lic?.plan_code || null;
  // легасі-коди → v2-slug
  const MAP = { solo: 'free', pro: 'professional' };
  if (slug && MAP[slug]) slug = MAP[slug];
  let plan = slug
    ? (await q(`SELECT * FROM saas_plans_v2 WHERE slug=$1 AND is_active=true LIMIT 1`, [slug]))[0]
    : null;
  if (!plan) plan = (await q(`SELECT * FROM saas_plans_v2 WHERE slug='free' LIMIT 1`))[0] || null;
  return { plan, license: lic || null };
}

// Поточне використання ресурсів тенанта (best-effort; невідомі таблиці → 0).
async function tenantUsage(tenantId) {
  const usage = {};
  const safe = async (key, sql) => {
    try { usage[key] = (await q(sql, [tenantId]))[0]?.n || 0; }
    catch (_) { usage[key] = 0; }
  };
  await Promise.all([
    safe('max_clients',   `SELECT count(*)::int n FROM clients WHERE tenant_id=$1`),
    safe('max_employees', `SELECT count(*)::int n FROM masters WHERE tenant_id=$1 AND coalesce(active,true)=true`),
    safe('max_branches',  `SELECT count(*)::int n FROM branches WHERE tenant_id=$1`),
    safe('max_services',  `SELECT count(*)::int n FROM services WHERE tenant_id=$1`),
  ]);
  return usage;
}

// Розрахунок headroom для кожного ліміту плану vs поточне використання.
function buildLimitsView(limits, usage) {
  return (limits || []).map(l => {
    const used = Number(usage[l.limit_key] ?? 0);
    const cap = Number(l.limit_value);
    const unlimited = cap < 0;
    const headroom = unlimited ? null : Math.max(0, cap - used);
    const pct = unlimited || cap === 0 ? 0 : Math.round((used / cap) * 100);
    let level = 'ok';
    if (!unlimited) {
      if (pct >= 100) level = 'exceeded';
      else if (pct >= 90) level = 'critical';
      else if (pct >= 80) level = 'warning';
    }
    return {
      limit_key: l.limit_key, limit_value: cap, is_soft: l.is_soft,
      unlimited, used, headroom, usage_pct: pct, level,
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API  /public/…   (без авторизації — pricing page)
══════════════════════════════════════════════════════════════════ */
const publicRouter = express.Router();

// GET /public/plans?currency=UAH — публічні опубліковані плани
publicRouter.get('/plans', async (req, res) => {
  try {
    const plans = await q(
      `SELECT * FROM saas_plans_v2
        WHERE is_public=true AND is_active=true AND status='published'
        ORDER BY sort_order, tier`);
    const out = plans.map(p => ({
      id: p.id, slug: p.slug, name: p.name, description: p.description,
      tier: p.tier, trial_days: p.trial_days, is_popular: p.is_popular,
      contact_sales: p.contact_sales, prices: pricesFor(p, req.query.currency),
    }));
    res.json({ rows: out, currency: out[0]?.prices.currency || 'UAH' });
  } catch (e) { return err500(res, e); }
});

// GET /public/plans/compare — матриця план × фіча/ліміт (раніше за /:slug)
publicRouter.get('/plans/compare', async (req, res) => {
  try {
    const plans = await q(
      `SELECT id, slug, name, tier FROM saas_plans_v2
        WHERE is_public=true AND is_active=true AND status='published'
        ORDER BY sort_order, tier`);
    const ids = plans.map(p => p.id);
    if (!ids.length) return res.json({ plans: [], features: [], limits: [] });
    const [feats, lims] = await Promise.all([
      q(`SELECT plan_id, feature_key, enabled FROM plan_features WHERE plan_id = ANY($1)`, [ids]),
      q(`SELECT plan_id, limit_key, limit_value FROM plan_limits WHERE plan_id = ANY($1)`, [ids]),
    ]);
    // фіча → { plan_slug: enabled }
    const fkeys = [...new Set(feats.map(f => f.feature_key))].sort();
    const lkeys = [...new Set(lims.map(l => l.limit_key))].sort();
    const planById = Object.fromEntries(plans.map(p => [p.id, p.slug]));
    const featMatrix = fkeys.map(fk => {
      const row = { feature_key: fk };
      for (const p of plans) row[p.slug] = false;
      for (const f of feats) if (f.feature_key === fk) row[planById[f.plan_id]] = f.enabled;
      return row;
    });
    const limMatrix = lkeys.map(lk => {
      const row = { limit_key: lk };
      for (const p of plans) row[p.slug] = null;
      for (const l of lims) if (l.limit_key === lk) row[planById[l.plan_id]] = l.limit_value;
      return row;
    });
    res.json({ plans: plans.map(p => ({ slug: p.slug, name: p.name, tier: p.tier })), features: featMatrix, limits: limMatrix });
  } catch (e) { return err500(res, e); }
});

// GET /public/plans/:slug — деталі плану (features + limits)
publicRouter.get('/plans/:slug', async (req, res) => {
  try {
    const plan = (await q(
      `SELECT * FROM saas_plans_v2 WHERE slug=$1 AND is_public=true AND is_active=true LIMIT 1`,
      [req.params.slug]))[0];
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });
    const detail = await planDetail(plan.id, req.query.currency);
    res.json(detail);
  } catch (e) { return err500(res, e); }
});

// GET /public/addons — публічні add-ons
publicRouter.get('/addons', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, slug, name, description, addon_type, limit_key, limit_boost_value,
              feature_key, price_monthly_uah, price_yearly_uah, price_one_time_uah, sort_order
         FROM plan_addons WHERE is_active=true AND is_public=true ORDER BY sort_order, name`);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   TENANT API  /tenant/…
══════════════════════════════════════════════════════════════════ */
const tenantRouter = express.Router();
tenantRouter.use(requirePerm('saas.read'));   // plans.tenant.read

// GET /tenant/plan — поточний план з usage vs limits + headroom
tenantRouter.get('/plan', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { plan, license } = await currentTenantPlan(tenantId);
    if (!plan) return res.status(404).json({ error: 'no_plan' });
    const [limits, features, usage] = await Promise.all([
      q(`SELECT limit_key, limit_value, is_soft FROM plan_limits WHERE plan_id=$1 ORDER BY limit_key`, [plan.id]),
      q(`SELECT feature_key, enabled FROM plan_features WHERE plan_id=$1 ORDER BY feature_key`, [plan.id]),
      tenantUsage(tenantId),
    ]);
    res.json({
      plan: {
        id: plan.id, slug: plan.slug, name: plan.name, tier: plan.tier,
        prices: pricesFor(plan, req.query.currency),
        trial_days: plan.trial_days,
      },
      status: license?.status || 'none',
      trial_ends_at: license?.trial_ends_at || null,
      next_billing_at: license?.expires_at || null,
      features,
      limits: buildLimitsView(limits, usage),
    });
  } catch (e) { return err500(res, e); }
});

// GET /tenant/plan/recommend — рекомендація плану за поточним використанням
tenantRouter.get('/plan/recommend', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { plan: current } = await currentTenantPlan(tenantId);
    const usage = await tenantUsage(tenantId);
    const plans = await q(
      `SELECT * FROM saas_plans_v2 WHERE is_active=true AND status='published' AND contact_sales=false
        ORDER BY tier`);
    // Для кожного плану — чи вміщається поточне використання у всі його ліміти.
    const reasons = [];
    let recommended = current;
    for (const p of plans) {
      const lims = await q(`SELECT limit_key, limit_value FROM plan_limits WHERE plan_id=$1`, [p.id]);
      const fits = lims.every(l => {
        const cap = Number(l.limit_value);
        return cap < 0 || Number(usage[l.limit_key] ?? 0) <= cap;
      });
      if (fits) { recommended = p; break; }
    }
    // Якщо поточний план переповнений — пояснити чому.
    if (current) {
      const curLims = await q(`SELECT limit_key, limit_value, is_soft FROM plan_limits WHERE plan_id=$1`, [current.id]);
      for (const l of curLims) {
        const cap = Number(l.limit_value);
        const used = Number(usage[l.limit_key] ?? 0);
        if (cap >= 0 && used > cap * 0.7) {
          reasons.push({ limit_key: l.limit_key, used, limit: cap, is_soft: l.is_soft });
        }
      }
    }
    const upgrade = recommended && current && recommended.tier > current.tier;
    const savings = upgrade
      ? Math.max(0, Number(recommended.price_monthly_uah) * 12 - Number(recommended.price_yearly_uah))
      : 0;
    res.json({
      current_plan: current ? { slug: current.slug, name: current.name, tier: current.tier } : null,
      recommended_plan: recommended ? { slug: recommended.slug, name: recommended.name, tier: recommended.tier } : null,
      upgrade_suggested: !!upgrade,
      reasons,
      yearly_savings_uah: savings,
    });
  } catch (e) { return err500(res, e); }
});

// GET /tenant/plan/upgrade-preview?target_plan=professional&cycle=monthly
// Prorated розрахунок переходу в середині циклу.
tenantRouter.get('/plan/upgrade-preview', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const cycle = req.query.cycle === 'yearly' ? 'yearly' : 'monthly';
    const target = (await q(
      `SELECT * FROM saas_plans_v2 WHERE slug=$1 AND is_active=true LIMIT 1`,
      [req.query.target_plan]))[0];
    if (!target) return res.status(404).json({ error: 'target_plan_not_found' });
    const { plan: current, license } = await currentTenantPlan(tenantId);

    const priceField = cycle === 'yearly' ? 'price_yearly_uah' : 'price_monthly_uah';
    const periodDays = cycle === 'yearly' ? 365 : 30;
    const curPrice = Number(current?.[priceField] || 0);
    const newPrice = Number(target[priceField] || 0);

    // Скільки днів лишилось у поточному циклі (за expires_at, інакше повний період).
    let daysLeft = periodDays;
    if (license?.expires_at) {
      const ms = new Date(license.expires_at).getTime() - Date.now();
      daysLeft = Math.max(0, Math.min(periodDays, Math.ceil(ms / 86400000)));
    }
    const unusedCredit = +(curPrice * (daysLeft / periodDays)).toFixed(2);   // кредит за невикористане
    const newProrated  = +(newPrice * (daysLeft / periodDays)).toFixed(2);   // нова ціна за залишок
    const dueNow = +Math.max(0, newProrated - unusedCredit).toFixed(2);
    const direction = !current ? 'new'
      : target.tier > current.tier ? 'upgrade'
      : target.tier < current.tier ? 'downgrade' : 'same';

    res.json({
      from_plan: current ? { slug: current.slug, name: current.name, tier: current.tier } : null,
      to_plan: { slug: target.slug, name: target.name, tier: target.tier },
      direction, cycle, days_left: daysLeft,
      current_price: curPrice, new_price: newPrice,
      unused_credit: unusedCredit, prorated_due_now: dueNow,
      next_billing_price: newPrice,
    });
  } catch (e) { return err500(res, e); }
});

// POST /tenant/plan/change {target_plan, cycle?} — РЕАЛЬНА зміна плану (аудит 06.07:
// раніше був лише preview). Prorated-розрахунок і рахунок робить lib/billing.changePlan;
// якщо підписки ще нема — створюємо (безкоштовні активні одразу, платні з рахунком).
tenantRouter.post('/plan/change', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const slug = String(req.body?.target_plan || '').trim();
    const cycle = req.body?.cycle === 'yearly' ? 'yearly' : (req.body?.cycle === 'monthly' ? 'monthly' : null);
    const target = (await q(
      `SELECT * FROM saas_plans_v2 WHERE slug=$1 AND is_active=true AND status='published' LIMIT 1`, [slug]))[0];
    if (!target) return res.status(404).json({ error: 'target_plan_not_found' });
    const { plan: current } = await currentTenantPlan(tenantId);
    if (current && current.slug === target.slug) return res.json({ ok: true, already: true, plan: target.slug });

    const billing = require('../lib/billing');
    let result;
    try {
      result = await billing.changePlan(tenantId, target.slug, cycle);
    } catch (e) {
      if (/subscription-not-found/.test(e.message)) {
        const sub = await billing.createSubscription(tenantId,
          { plan_code: target.slug, cycle: cycle || 'monthly', trial: false }, req.user || null);
        result = { subscription: sub, proration: 0 };
      } else throw e;
    }
    // історія зміни плану + інвалідація кешу фічегейтів (діяло б до 60с старе)
    const action = !current ? 'created' : (target.tier > current.tier ? 'upgraded' : (target.tier < current.tier ? 'downgraded' : 'renewed'));
    await q(`INSERT INTO plan_change_log (tenant_id, action, from_plan_id, to_plan_id, prorated_uah, actor_type, details)
             VALUES ($1, $2::plan_change_action_enum, $3, $4, $5, 'tenant', $6)`,
      [tenantId, action, current ? current.id : null, target.id, result.proration || 0,
       JSON.stringify({ by: req.user?.display_name || null, cycle: cycle || result.subscription?.billing_cycle })]).catch(e => console.error('[plans/change] log:', e.message));
    try { require('../lib/feature-gate').invalidateFeatureCache(tenantId); } catch (_) {}
    await logAction({ user: req.user, action: 'plans.change', entity: 'subscriptions_saas',
      entity_id: tenantId, meta: { to: target.slug, action, proration: result.proration }, ip: req.ip }).catch(() => {});
    res.json({ ok: true, action, plan: target.slug, proration: result.proration,
      subscription: { status: result.subscription?.status, period_end: result.subscription?.current_period_end } });
  } catch (e) { return err500(res, e); }
});

// GET /tenant/addons — підключені add-ons тенанта
tenantRouter.get('/addons', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const rows = await q(
      `SELECT tpa.id, tpa.status, tpa.cycle, tpa.price_uah, tpa.subscribed_at, tpa.cancel_at,
              a.slug, a.name, a.description, a.addon_type, a.limit_key, a.limit_boost_value, a.feature_key
         FROM tenant_plan_addons tpa
         JOIN plan_addons a ON a.id = tpa.addon_id
        WHERE tpa.tenant_id=$1 AND tpa.status <> 'cancelled'
        ORDER BY tpa.subscribed_at DESC`, [tenantId]);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// POST /tenant/addons/:id/subscribe — підключити add-on { cycle }
// Реальна оплата — graceful-стаб: якщо платіжний шлюз не налаштований, add-on
// створюється у статусі pending (operator активує після оплати); інакше active.
tenantRouter.post('/addons/:id/subscribe', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    if (!tenantId) return res.status(400).json({ error: 'no_tenant' });
    const cycle = ['monthly', 'yearly', 'one_time'].includes(req.body?.cycle) ? req.body.cycle : 'monthly';
    const addon = (await q(`SELECT * FROM plan_addons WHERE id=$1 AND is_active=true`, [req.params.id]))[0];
    if (!addon) return res.status(404).json({ error: 'addon_not_found' });

    // Сумісність з поточним планом.
    const { plan } = await currentTenantPlan(tenantId);
    if (addon.compatible_plans && addon.compatible_plans.length && plan &&
        !addon.compatible_plans.includes(plan.id)) {
      return res.status(409).json({ error: 'addon_incompatible_with_plan' });
    }

    const priceField = cycle === 'yearly' ? 'price_yearly_uah'
      : cycle === 'one_time' ? 'price_one_time_uah' : 'price_monthly_uah';
    const price = Number(addon[priceField] || 0);

    // Платіжний шлюз: graceful-стаб.
    let payUrl = null, payStatus = 'active';
    if (price > 0) {
      try {
        const billing = require('../lib/billing');
        if (typeof billing.createAddonInvoice === 'function' &&
            typeof billing.createSubscriptionPayLink === 'function') {
          const { invoice } = await billing.createAddonInvoice(tenantId, addon.slug, cycle === 'yearly' ? 'yearly' : 'monthly');
          const pay = await billing.createSubscriptionPayLink(invoice.id);
          payUrl = pay.pay_url; payStatus = 'pending';
        } else {
          payStatus = 'pending';   // немає білінгу → чекаємо ручної активації
        }
      } catch (e) {
        // gateway-not-configured / addon-not-found у легасі-каталозі → graceful pending
        payStatus = 'pending';
      }
    }

    const row = (await q(
      `INSERT INTO tenant_plan_addons (tenant_id, addon_id, cycle, status, price_uah)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, addon_id) WHERE status IN ('active','pending')
       DO UPDATE SET cycle=EXCLUDED.cycle, status=EXCLUDED.status, price_uah=EXCLUDED.price_uah, updated_at=now()
       RETURNING *`,
      [tenantId, addon.id, cycle, payStatus, price]))[0];
    await logAction({ user: req.user, action: 'plans.addon_subscribe', entity: 'tenant_plan_addons',
      entity_id: row.id, meta: { addon: addon.slug, cycle, status: payStatus }, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, addon: addon.slug, cycle, price, status: payStatus, pay_url: payUrl, subscription: row });
  } catch (e) { return err500(res, e); }
});

// DELETE /tenant/addons/:id/unsubscribe — відключити в кінці періоду
tenantRouter.delete('/addons/:id/unsubscribe', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    if (!tenantId) return res.status(400).json({ error: 'no_tenant' });
    // :id — id підписки tenant_plan_addons або id самого add-on.
    const row = (await q(
      `UPDATE tenant_plan_addons
          SET status='cancelled', cancel_at=now(), cancelled_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND (id=$2 OR addon_id=$2) AND status<>'cancelled'
        RETURNING *`, [tenantId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'subscription_not_found' });
    await logAction({ user: req.user, action: 'plans.addon_unsubscribe', entity: 'tenant_plan_addons',
      entity_id: row.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, subscription: row });
  } catch (e) { return err500(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   ADMIN API  /admin/…   (суперадмін)
══════════════════════════════════════════════════════════════════ */
const adminRouter = express.Router();
const platformOnly = requirePlatform();
// Read: saas.read; Write: platformOnly (суперадмін).
adminRouter.use((req, res, next) => {
  if (req.method === 'GET') return requirePerm('saas.read')(req, res, next);
  return platformOnly(req, res, next);
});

// GET /admin/plans — усі плани (включно з inactive/draft)
adminRouter.get('/plans', async (req, res) => {
  try {
    const rows = await q(
      `SELECT p.*,
              (SELECT count(*)::int FROM plan_features f WHERE f.plan_id=p.id) AS features_count,
              (SELECT count(*)::int FROM plan_limits  l WHERE l.plan_id=p.id) AS limits_count
         FROM saas_plans_v2 p ORDER BY p.sort_order, p.tier`);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// POST /admin/plans — створити план (у т.ч. кастомний Enterprise)
adminRouter.post('/plans', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.slug) return res.status(400).json({ error: 'name_and_slug_required' });
    const row = (await q(
      `INSERT INTO saas_plans_v2
         (name, slug, description, tier, price_monthly_uah, price_yearly_uah,
          price_monthly_usd, price_yearly_usd, price_monthly_eur, price_yearly_eur,
          trial_days, status, is_public, is_active, is_popular, contact_sales, sort_order, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::plan_status_enum,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [b.name, b.slug, b.description || null, b.tier ?? 9,
       b.price_monthly_uah || 0, b.price_yearly_uah || 0,
       b.price_monthly_usd || 0, b.price_yearly_usd || 0,
       b.price_monthly_eur || 0, b.price_yearly_eur || 0,
       b.trial_days ?? 14, b.status || 'draft',
       b.is_public !== false, b.is_active !== false, !!b.is_popular, !!b.contact_sales,
       b.sort_order || 0, JSON.stringify(b.metadata || {})]))[0];
    await logAction({ user: req.user, action: 'plans.create', entity: 'saas_plans_v2', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_exists' });
    return err500(res, e);
  }
});

// PUT /admin/plans/:id — змінити план. При зміні ціни — версіонування (legacy зберігається).
adminRouter.put('/plans/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const cur = (await q(`SELECT * FROM saas_plans_v2 WHERE id=$1`, [req.params.id]))[0];
    if (!cur) return res.status(404).json({ error: 'plan_not_found' });

    const fields = ['name','description','tier','price_monthly_uah','price_yearly_uah',
      'price_monthly_usd','price_yearly_usd','price_monthly_eur','price_yearly_eur',
      'trial_days','is_public','is_active','is_popular','contact_sales','sort_order'];
    const sets = [], params = [];
    for (const f of fields) {
      if (b[f] !== undefined) { params.push(b[f]); sets.push(`${f}=$${params.length}`); }
    }
    if (b.status !== undefined) { params.push(b.status); sets.push(`status=$${params.length}::plan_status_enum`); }
    if (b.metadata !== undefined) { params.push(JSON.stringify(b.metadata)); sets.push(`metadata=$${params.length}`); }

    const priceChanged = ['price_monthly_uah','price_yearly_uah'].some(
      f => b[f] !== undefined && Number(b[f]) !== Number(cur[f]));
    if (priceChanged) { params.push(cur.version + 1); sets.push(`version=$${params.length}`); }

    if (!sets.length) return res.json(cur);
    sets.push('updated_at=now()');
    params.push(req.params.id);
    const row = (await q(
      `UPDATE saas_plans_v2 SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params))[0];
    await logAction({ user: req.user, action: 'plans.update', entity: 'saas_plans_v2',
      entity_id: row.id, meta: { price_versioned: priceChanged }, ip: req.ip }).catch(() => {});
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// DELETE /admin/plans/:id — деактивація (не видалення)
adminRouter.delete('/plans/:id', async (req, res) => {
  try {
    const row = (await q(
      `UPDATE saas_plans_v2 SET is_active=false, status='archived', updated_at=now()
        WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'plan_not_found' });
    await logAction({ user: req.user, action: 'plans.deactivate', entity: 'saas_plans_v2', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(204).end();
  } catch (e) { return err500(res, e); }
});

// GET /admin/plans/:id/features
adminRouter.get('/plans/:id/features', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, feature_key, enabled, metadata FROM plan_features WHERE plan_id=$1 ORDER BY feature_key`,
      [req.params.id]);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// PUT /admin/plans/:id/features — { features: [{key,enabled}] } (upsert матриці)
adminRouter.put('/plans/:id/features', async (req, res) => {
  const client = await pool.connect();
  try {
    const planId = req.params.id;
    const list = Array.isArray(req.body?.features) ? req.body.features : [];
    await client.query('BEGIN');
    for (const f of list) {
      if (!f.key) continue;
      await client.query(
        `INSERT INTO plan_features (plan_id, feature_key, enabled)
         VALUES ($1,$2,$3)
         ON CONFLICT (plan_id, feature_key) DO UPDATE SET enabled=EXCLUDED.enabled`,
        [planId, f.key, !!f.enabled]);
    }
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'plans.features_update', entity: 'plan_features',
      entity_id: planId, meta: { count: list.length }, ip: req.ip }).catch(() => {});
    const rows = await q(`SELECT feature_key, enabled FROM plan_features WHERE plan_id=$1 ORDER BY feature_key`, [planId]);
    res.json({ rows });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return err500(res, e); }
  finally { client.release(); }
});

// GET /admin/plans/:id/limits
adminRouter.get('/plans/:id/limits', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, limit_key, limit_value, is_soft FROM plan_limits WHERE plan_id=$1 ORDER BY limit_key`,
      [req.params.id]);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// PUT /admin/plans/:id/limits — { limits: [{key,value,is_soft}] }
adminRouter.put('/plans/:id/limits', async (req, res) => {
  const client = await pool.connect();
  try {
    const planId = req.params.id;
    const list = Array.isArray(req.body?.limits) ? req.body.limits : [];
    await client.query('BEGIN');
    for (const l of list) {
      if (!l.key) continue;
      await client.query(
        `INSERT INTO plan_limits (plan_id, limit_key, limit_value, is_soft)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (plan_id, limit_key) DO UPDATE SET limit_value=EXCLUDED.limit_value, is_soft=EXCLUDED.is_soft`,
        [planId, l.key, Number(l.value ?? 0), !!l.is_soft]);
    }
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'plans.limits_update', entity: 'plan_limits',
      entity_id: planId, meta: { count: list.length }, ip: req.ip }).catch(() => {});
    const rows = await q(`SELECT limit_key, limit_value, is_soft FROM plan_limits WHERE plan_id=$1 ORDER BY limit_key`, [planId]);
    res.json({ rows });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return err500(res, e); }
  finally { client.release(); }
});

// GET /admin/plans/:id/tenants — тенанти на цьому плані (через legacy tenant_licenses)
// Аудит v6: saas.read є в owner/admin КОЖНОГО салону (мігр. 096) — цей ендпоінт віддавав
// список УСІХ салонів платформи та їхні плани будь-якому власнику. Тільки платформа.
adminRouter.get('/plans/:id/tenants', platformOnly, async (req, res) => {
  try {
    const plan = (await q(`SELECT slug FROM saas_plans_v2 WHERE id=$1`, [req.params.id]))[0];
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });
    // мапимо v2-slug на легасі-коди, що можуть зберігатись у tenant_licenses
    const codes = [plan.slug];
    if (plan.slug === 'free') codes.push('solo');
    if (plan.slug === 'professional') codes.push('pro');
    const rows = await q(
      `SELECT tenant_id, plan_code, status, trial_ends_at, expires_at, updated_at
         FROM tenant_licenses WHERE plan_code = ANY($1) ORDER BY updated_at DESC`, [codes]);
    res.json({ rows, count: rows.length });
  } catch (e) { return err500(res, e); }
});

// GET /admin/plans/:id/change-log — історія зміни плану (по всіх тенантах)
adminRouter.get('/plans/:id/change-log', async (req, res) => {
  try {
    const rows = await q(
      `SELECT * FROM plan_change_log
        WHERE from_plan_id=$1 OR to_plan_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

/* ── Add-ons admin ──────────────────────────────────────────────── */

// GET /admin/addons — усі add-ons
adminRouter.get('/addons', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM plan_addons ORDER BY sort_order, name`);
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// POST /admin/addons
adminRouter.post('/addons', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.slug || !b.addon_type) return res.status(400).json({ error: 'name_slug_type_required' });
    const row = (await q(
      `INSERT INTO plan_addons
         (name, slug, description, addon_type, limit_key, limit_boost_value, feature_key,
          price_monthly_uah, price_yearly_uah, price_one_time_uah, compatible_plans,
          is_active, is_public, sort_order, metadata)
       VALUES ($1,$2,$3,$4::addon_type_enum,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [b.name, b.slug, b.description || null, b.addon_type,
       b.limit_key || null, b.limit_boost_value || null, b.feature_key || null,
       b.price_monthly_uah || 0, b.price_yearly_uah || 0, b.price_one_time_uah || 0,
       b.compatible_plans || [], b.is_active !== false, b.is_public !== false,
       b.sort_order || 0, JSON.stringify(b.metadata || {})]))[0];
    await logAction({ user: req.user, action: 'plans.addon_create', entity: 'plan_addons', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_exists' });
    return err500(res, e);
  }
});

// PUT /admin/addons/:id
adminRouter.put('/addons/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const fields = ['name','description','addon_type','limit_key','limit_boost_value','feature_key',
      'price_monthly_uah','price_yearly_uah','price_one_time_uah','is_active','is_public','sort_order'];
    const sets = [], params = [];
    for (const f of fields) {
      if (b[f] !== undefined) {
        params.push(b[f]);
        sets.push(f === 'addon_type' ? `addon_type=$${params.length}::addon_type_enum` : `${f}=$${params.length}`);
      }
    }
    if (b.compatible_plans !== undefined) { params.push(b.compatible_plans); sets.push(`compatible_plans=$${params.length}`); }
    if (b.metadata !== undefined) { params.push(JSON.stringify(b.metadata)); sets.push(`metadata=$${params.length}`); }
    if (!sets.length) {
      const cur = (await q(`SELECT * FROM plan_addons WHERE id=$1`, [req.params.id]))[0];
      if (!cur) return res.status(404).json({ error: 'addon_not_found' });
      return res.json(cur);
    }
    sets.push('updated_at=now()');
    params.push(req.params.id);
    const row = (await q(`UPDATE plan_addons SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'addon_not_found' });
    await logAction({ user: req.user, action: 'plans.addon_update', entity: 'plan_addons', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// DELETE /admin/addons/:id — деактивація
adminRouter.delete('/addons/:id', async (req, res) => {
  try {
    const row = (await q(`UPDATE plan_addons SET is_active=false, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'addon_not_found' });
    await logAction({ user: req.user, action: 'plans.addon_delete', entity: 'plan_addons', entity_id: row.id, ip: req.ip }).catch(() => {});
    res.status(204).end();
  } catch (e) { return err500(res, e); }
});

/* ── Wire sub-routers ──────────────────────────────────────────── */
router.use('/public', publicRouter);
router.use('/tenant', tenantRouter);
router.use('/admin',  adminRouter);

module.exports = router;
