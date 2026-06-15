/* ═══════════════════════════════════════════════════════
   SAS-04 Plans · SAS-05 Licenses · SAS-10 Feature Flags
   Подключается как /api/saas

   Что закрывает:
   - тарифные планы Free/Pro/Enterprise (saas_plans) + CRUD;
   - реестр фич платформы (feature_flags) + CRUD;
   - лицензия арендатора (tenant_licenses): план + индивидуальные overrides;
   - GET /features — ЭФФЕКТИВНЫЙ набор фич текущего арендатора
     (план + overrides + дефолты флагов) для показа/скрытия модулей в UI;
   - проверка лимитов плана (clients/masters) — /usage.

   Права: saas.read (чтение, все рабочие роли) / saas.write (управление, admin).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'saas.read' : 'saas.write';
  return requirePerm(perm)(req, res, next);
});

// вычислить эффективные фичи арендатора
async function effectiveFeatures() {
  const flags = await q(`SELECT key, default_enabled FROM feature_flags`);
  const lic = (await q(`SELECT * FROM tenant_licenses WHERE tenant_id=current_tenant_id() LIMIT 1`))[0];
  let planFeatures = [];
  let planCode = null, status = 'none';
  if (lic) {
    planCode = lic.plan_code; status = lic.status;
    const plan = (await q(`SELECT features FROM saas_plans WHERE code=$1`, [lic.plan_code]))[0];
    planFeatures = plan ? plan.features : [];
  }
  const planHasAll = Array.isArray(planFeatures) && planFeatures.includes('*');
  const overrides = (lic && lic.overrides) || {};

  const result = {};
  for (const f of flags) {
    let on = f.default_enabled;
    if (lic) on = planHasAll || (Array.isArray(planFeatures) && planFeatures.includes(f.key));
    if (Object.prototype.hasOwnProperty.call(overrides, f.key)) on = !!overrides[f.key];
    result[f.key] = on;
  }
  return { plan: planCode, status, features: result };
}

/* ── ЭФФЕКТИВНЫЕ ФИЧИ (для UI) ── */
router.get('/features', async (req, res) => {
  try { res.json(await effectiveFeatures()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── ПЛАНЫ ── */
router.get('/plans', async (req, res) => {
  try { res.json({ rows: await q(`SELECT * FROM saas_plans ORDER BY sort_order NULLS LAST, price_month`) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !b.name) return res.status(400).json({ error: 'code_and_name_required' });
    const row = (await q(
      `INSERT INTO saas_plans (code,name,price_month,price_year,features,limits,active,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, price_month=EXCLUDED.price_month,
         price_year=EXCLUDED.price_year, features=EXCLUDED.features, limits=EXCLUDED.limits,
         active=EXCLUDED.active, sort_order=EXCLUDED.sort_order
       RETURNING *`,
      [b.code, b.name, b.price_month || 0, b.price_year || 0,
       JSON.stringify(b.features || []), JSON.stringify(b.limits || {}),
       b.active !== false, b.sort_order || null]))[0];
    await logAction({ user: req.user, action: 'saas.plan_upsert', entity: 'saas_plans', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── ФИЧ-ФЛАГИ ── */
router.get('/flags', async (req, res) => {
  try { res.json({ rows: await q(`SELECT * FROM feature_flags ORDER BY key`) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/flags', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.key) return res.status(400).json({ error: 'key_required' });
    const row = (await q(
      `INSERT INTO feature_flags (key,name,description,default_enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         default_enabled=EXCLUDED.default_enabled
       RETURNING *`,
      [b.key, b.name || null, b.description || null, !!b.default_enabled]))[0];
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── ЛИЦЕНЗИЯ АРЕНДАТОРА ── */
router.get('/license', async (req, res) => {
  try {
    const lic = (await q(`SELECT * FROM tenant_licenses WHERE tenant_id=current_tenant_id() LIMIT 1`))[0];
    res.json(lic || { plan_code: null, status: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/saas/license — назначить/изменить план и overrides текущему арендатору
router.put('/license', async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await q(
      `INSERT INTO tenant_licenses (tenant_id, plan_code, status, overrides, trial_ends_at, expires_at, updated_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan_code=COALESCE(EXCLUDED.plan_code, tenant_licenses.plan_code),
         status=COALESCE(EXCLUDED.status, tenant_licenses.status),
         overrides=COALESCE(EXCLUDED.overrides, tenant_licenses.overrides),
         trial_ends_at=EXCLUDED.trial_ends_at, expires_at=EXCLUDED.expires_at, updated_at=now()
       RETURNING *`,
      [b.plan_code || null, b.status || 'active',
       b.overrides ? JSON.stringify(b.overrides) : null,
       b.trial_ends_at || null, b.expires_at || null]))[0];
    await logAction({ user: req.user, action: 'saas.license_update', entity: 'tenant_licenses', ip: req.ip });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/saas/usage — текущее использование против лимитов плана
router.get('/usage', async (req, res) => {
  try {
    const lic = (await q(`SELECT plan_code FROM tenant_licenses WHERE tenant_id=current_tenant_id() LIMIT 1`))[0];
    const plan = lic ? (await q(`SELECT limits FROM saas_plans WHERE code=$1`, [lic.plan_code]))[0] : null;
    const limits = plan ? plan.limits : {};
    const clients = (await q(`SELECT count(*)::int n FROM clients WHERE tenant_id=current_tenant_id()`))[0].n;
    const masters = (await q(`SELECT count(*)::int n FROM masters WHERE tenant_id=current_tenant_id() AND coalesce(active,true)=true`))[0].n;
    res.json({
      plan: lic ? lic.plan_code : null, limits,
      usage: { clients, masters },
      over_limit: {
        clients: limits.clients > 0 && clients > limits.clients,
        masters: limits.masters > 0 && masters > limits.masters,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
