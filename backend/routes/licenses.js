/* ═══════════════════════════════════════════════════════════════════════
   SAS-05 LICENSES — Module-level licensing lifecycle
   Підключається як /api/licenses

   Що закриває:
   - module_catalog: каталог ліцензованих модулів платформи (CRUD)
   - licenses:       per-module per-tenant ліцензії (trial/subscription/perpetual)
   - license_activations: повний аудит-лог операцій з ліцензіями
   - license_keys:   генерація/перевірка ключів для on-premise інсталяцій (JWT+RSA-stub)
   - Тенантний API: /my, /trial, /check/:code, /purchase
   - Адмін API:     /catalog CRUD, /admin/* (grant, revoke, extend-trial, bulk-grant, keys)
   - Trial: 1 раз per module per tenant + countdown + авто-expire
   - Grace period: 7 днів read-only після expire підписки
   - Перевірка залежностей при деактивації (dependency guard)

   Права: licenses.read (GET тенант), licenses.manage (admin mutations),
          licenses.catalog.manage (каталог модулів)
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, requirePlatform, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Поточний tenant_id через RLS-функцію */
async function currentTenant() {
  const r = await q(`SELECT current_tenant_id() AS id`);
  return r[0]?.id || null;
}

/** Логування активації ліцензії */
async function logActivation(licenseId, action, req, details = {}) {
  try {
    await q(
      `INSERT INTO license_activations (license_id, action, actor_id, actor_type, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [licenseId, action, req?.user?.id || null,
       req?.user?.id ? 'user' : 'system',
       JSON.stringify(details), req?.ip || null]
    );
  } catch (_) { /* non-fatal */ }
}

/** Перевірка залежностей при деактивації */
async function checkDeactivateSafe(moduleId) {
  // Чи є активні ліцензії, що залежать від цього модуля?
  const deps = await q(
    `SELECT m.code, m.name FROM module_catalog m
      JOIN licenses l ON l.module_id = m.id
     WHERE l.status IN ('active','grace_period')
       AND l.tenant_id = current_tenant_id()
       AND $1 = ANY(m.dependencies)`,
    [moduleId]
  );
  return deps; // Якщо не пусто — деактивація заблокована
}

/** Проста stub-генерація "ліцензійного ключа" (JWT-like base64 payload + SHA-256 hash) */
function generateLicenseKey(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig   = crypto.createHmac('sha256', process.env.LICENSE_KEY_SECRET || 'svs-license-2026')
                      .update(data).digest('base64url');
  return `${data}.${sig}`;
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ── Middleware ────────────────────────────────────────────────────────────────
const authRead    = requirePerm('licenses.read');
const authManage  = requirePerm('licenses.manage');
const platformOnly = requirePlatform();

// ═══════════════════════════════════════════════════════════════════════════
// MODULE CATALOG (публічний для всіх авторизованих, мутації — платформа)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/licenses/catalog — каталог модулів (публічний: вітрина) */
router.get('/catalog', authRead, async (req, res) => {
  try {
    const { category, status = 'available' } = req.query;
    const params = [];
    let where = `WHERE 1=1`;
    if (status)   { params.push(status);    where += ` AND mc.status = $${params.length}`; }
    if (category) { params.push(category);  where += ` AND mc.category = $${params.length}`; }

    // Для кожного модуля — стан ліцензії поточного тенанта
    const rows = await q(
      `SELECT mc.*,
              l.id           AS license_id,
              l.license_type AS tenant_license_type,
              l.status       AS tenant_license_status,
              l.expires_at   AS tenant_expires_at,
              l.activated_at AS tenant_activated_at,
              CASE WHEN l.license_type = 'trial' AND l.expires_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(epoch FROM (l.expires_at - now())) / 86400)::int
                   ELSE NULL END AS trial_days_left
       FROM module_catalog mc
       LEFT JOIN licenses l ON l.module_id = mc.id
                           AND l.tenant_id = current_tenant_id()
                           AND l.status IN ('active','grace_period')
       ${where}
       ORDER BY mc.sort_order, mc.name`,
      params
    );
    res.json({ count: rows.length, rows });
  } catch (e) {
    console.error('[licenses/catalog]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** GET /api/licenses/catalog/:id — деталі модуля */
router.get('/catalog/:id', authRead, async (req, res) => {
  try {
    const mc = (await q(`SELECT * FROM module_catalog WHERE id=$1`, [req.params.id]))[0];
    if (!mc) return res.status(404).json({ error: 'module_not_found' });

    // Залежності: назви
    let deps = [];
    if (mc.dependencies && mc.dependencies.length > 0) {
      deps = await q(`SELECT id, code, name FROM module_catalog WHERE id = ANY($1)`, [mc.dependencies]);
    }
    // Статистика ліцензій (суперадмін бачить більше)
    const stats = (await q(
      `SELECT COUNT(*) FILTER (WHERE status='active')      AS active,
              COUNT(*) FILTER (WHERE license_type='trial') AS trials,
              COUNT(*) FILTER (WHERE license_type='subscription') AS subscriptions
       FROM licenses WHERE module_id=$1`, [mc.id]))[0];

    res.json({ ...mc, dependencies_detail: deps, stats });
  } catch (e) {
    console.error('[licenses/catalog/:id]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/catalog — створити/оновити модуль (platformOnly) */
router.post('/catalog', platformOnly, authManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !b.name) return res.status(400).json({ error: 'code_and_name_required' });
    const row = (await q(
      `INSERT INTO module_catalog
         (code, name, description, category, icon_url, dependencies, min_plan_tier,
          price_monthly_uah, price_yearly_uah, price_perpetual_uah, trial_days, status, sort_order, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (code) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
         icon_url=EXCLUDED.icon_url, dependencies=EXCLUDED.dependencies, min_plan_tier=EXCLUDED.min_plan_tier,
         price_monthly_uah=EXCLUDED.price_monthly_uah, price_yearly_uah=EXCLUDED.price_yearly_uah,
         price_perpetual_uah=EXCLUDED.price_perpetual_uah, trial_days=EXCLUDED.trial_days,
         status=EXCLUDED.status, sort_order=EXCLUDED.sort_order, metadata=EXCLUDED.metadata,
         updated_at=now()
       RETURNING *`,
      [b.code, b.name, b.description || null, b.category || 'crm', b.icon_url || null,
       b.dependencies || [], b.min_plan_tier || 0,
       b.price_monthly_uah || 0, b.price_yearly_uah || 0, b.price_perpetual_uah || 0,
       b.trial_days ?? 14, b.status || 'available', b.sort_order || 0,
       JSON.stringify(b.metadata || {})]
    ))[0];
    res.status(201).json(row);
  } catch (e) {
    console.error('[licenses/catalog POST]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** PUT /api/licenses/catalog/:id — оновити модуль (platformOnly) */
router.put('/catalog/:id', platformOnly, authManage, async (req, res) => {
  try {
    const b = req.body || {};
    const row = (await q(
      `UPDATE module_catalog SET
         name=COALESCE($2, name), description=COALESCE($3, description),
         status=COALESCE($4::module_status_enum, status),
         price_monthly_uah=COALESCE($5, price_monthly_uah),
         price_yearly_uah=COALESCE($6, price_yearly_uah),
         sort_order=COALESCE($7, sort_order), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, b.name || null, b.description || null,
       b.status || null, b.price_monthly_uah ?? null, b.price_yearly_uah ?? null,
       b.sort_order ?? null]
    ))[0];
    if (!row) return res.status(404).json({ error: 'module_not_found' });
    res.json(row);
  } catch (e) {
    console.error('[licenses/catalog PUT]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TENANT API: мої ліцензії, trial, перевірка
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/licenses/my — активні ліцензії поточного тенанта */
router.get('/my', authRead, async (req, res) => {
  try {
    const rows = await q(
      `SELECT l.*, mc.code, mc.name AS module_name, mc.category, mc.description,
              CASE WHEN l.license_type='trial' AND l.expires_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(epoch FROM (l.expires_at - now()))/86400)::int
                   ELSE NULL END AS trial_days_left
       FROM licenses l
       JOIN module_catalog mc ON mc.id = l.module_id
       WHERE l.tenant_id = current_tenant_id()
         AND l.status IN ('active','grace_period','expired')
       ORDER BY l.activated_at DESC`
    );
    res.json({ count: rows.length, rows });
  } catch (e) {
    console.error('[licenses/my]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** GET /api/licenses/check/:code — перевірити ліцензію модуля за кодом */
router.get('/check/:code', authRead, async (req, res) => {
  try {
    const row = await q(
      `SELECT l.id, l.license_type, l.status, l.expires_at, l.grace_period_ends,
              CASE WHEN l.license_type='trial' AND l.expires_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(epoch FROM (l.expires_at - now()))/86400)::int
                   ELSE NULL END AS trial_days_left
       FROM licenses l
       JOIN module_catalog mc ON mc.id = l.module_id
       WHERE mc.code = $1
         AND l.tenant_id = current_tenant_id()
         AND l.status IN ('active','grace_period')
       LIMIT 1`,
      [req.params.code]
    );
    const lic = row[0] || null;
    res.json({
      code: req.params.code,
      licensed: !!lic,
      type: lic?.license_type || null,
      status: lic?.status || 'none',
      expires_at: lic?.expires_at || null,
      trial_days_left: lic?.trial_days_left ?? null,
    });
  } catch (e) {
    console.error('[licenses/check]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/trial — почати trial для модуля { module_id } */
router.post('/trial', authRead, async (req, res) => {
  try {
    const { module_id } = req.body || {};
    if (!module_id) return res.status(400).json({ error: 'module_id_required' });

    const mc = (await q(`SELECT * FROM module_catalog WHERE id=$1 AND status='available'`, [module_id]))[0];
    if (!mc) return res.status(404).json({ error: 'module_not_found' });

    // Перевірка: 1 trial per module per tenant
    const existing = await q(
      `SELECT id, status, license_type FROM licenses
       WHERE module_id=$1 AND tenant_id=current_tenant_id()`,
      [module_id]
    );
    if (existing.length > 0) {
      const prev = existing[0];
      if (prev.status === 'active' || prev.status === 'grace_period') {
        return res.status(409).json({ error: 'already_licensed', status: prev.status, type: prev.license_type });
      }
      if (prev.license_type === 'trial') {
        return res.status(409).json({ error: 'trial_already_used', message: 'Один trial per module per tenant' });
      }
    }

    const trialDays = mc.trial_days || 14;
    const expiresAt = new Date(Date.now() + trialDays * 86400_000);

    const [lic] = await q(
      `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at)
       VALUES (current_tenant_id(), $1, 'trial', 'active', now(), $2)
       RETURNING *`,
      [module_id, expiresAt]
    );
    await logActivation(lic.id, 'trial_started', req, { module_code: mc.code, trial_days: trialDays });
    res.status(201).json({ ok: true, license: lic, trial_days: trialDays, expires_at: expiresAt });
  } catch (e) {
    console.error('[licenses/trial]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** DELETE /api/licenses/:id — деактивувати ліцензію (кінець поточного периоду) */
router.delete('/:id', authRead, async (req, res) => {
  try {
    const lic = (await q(
      `SELECT l.*, mc.id AS module_catalog_id FROM licenses l
       JOIN module_catalog mc ON mc.id = l.module_id
       WHERE l.id=$1 AND l.tenant_id=current_tenant_id()`,
      [req.params.id]
    ))[0];
    if (!lic) return res.status(404).json({ error: 'license_not_found' });
    if (lic.status === 'revoked') return res.status(400).json({ error: 'already_revoked' });

    // Перевірка залежностей
    const deps = await checkDeactivateSafe(lic.module_catalog_id);
    if (deps.length > 0) {
      return res.status(409).json({
        error: 'dependency_conflict',
        message: 'Інші активні модулі залежать від цього',
        blocking: deps.map(d => ({ code: d.code, name: d.name })),
      });
    }

    const [updated] = await q(
      `UPDATE licenses SET status='revoked', revoked_at=now(), updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`,
      [req.params.id]
    );
    await logActivation(lic.id, 'deactivated', req, { by: 'tenant' });
    res.json({ ok: true, license: updated });
  } catch (e) {
    console.error('[licenses DELETE]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** GET /api/licenses/:id/history — аудит-лог ліцензії */
router.get('/:id/history', authRead, async (req, res) => {
  try {
    // Перевірка, що ліцензія належить поточному тенанту (або superadmin)
    const lic = (await q(
      `SELECT id FROM licenses WHERE id=$1 AND tenant_id=current_tenant_id()`,
      [req.params.id]
    ))[0];
    if (!lic) return res.status(404).json({ error: 'license_not_found' });

    const rows = await q(
      `SELECT * FROM license_activations WHERE license_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[licenses/:id/history]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN API: grant / revoke / extend-trial / bulk-grant / license-keys
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/licenses/admin/all — всі ліцензії з фільтрами */
router.get('/admin/all', platformOnly, authManage, async (req, res) => {
  try {
    const { tenant_id, module_id, status, page = 1, per_page = 50 } = req.query;
    const params = [];
    let where = `WHERE 1=1`;
    if (tenant_id)  { params.push(tenant_id);  where += ` AND l.tenant_id=$${params.length}`; }
    if (module_id)  { params.push(module_id);  where += ` AND l.module_id=$${params.length}`; }
    if (status)     { params.push(status);     where += ` AND l.status::text=$${params.length}`; }

    const offset = (Number(page) - 1) * Number(per_page);
    params.push(Number(per_page)); params.push(offset);

    const rows = await q(
      `SELECT l.*, mc.code, mc.name AS module_name, mc.category
       FROM licenses l JOIN module_catalog mc ON mc.id=l.module_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ page: Number(page), per_page: Number(per_page), count: rows.length, rows });
  } catch (e) {
    console.error('[licenses/admin/all]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/grant — видати ліцензію тенанту */
router.post('/admin/grant', platformOnly, authManage, async (req, res) => {
  try {
    const { tenant_id, module_id, type = 'subscription', expires_at } = req.body || {};
    if (!tenant_id || !module_id) return res.status(400).json({ error: 'tenant_id_and_module_id_required' });
    if (!['trial','subscription','perpetual'].includes(type))
      return res.status(400).json({ error: 'invalid_type' });

    const mc = (await q(`SELECT * FROM module_catalog WHERE id=$1`, [module_id]))[0];
    if (!mc) return res.status(404).json({ error: 'module_not_found' });

    // Upsert: якщо вже є активна — оновити
    const [lic] = await q(
      `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at)
       VALUES ($1,$2,$3,'active',now(),$4)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [tenant_id, module_id, type, expires_at || null]
    );
    // Якщо ON CONFLICT спрацював — знайдемо існуючу
    const final = lic || (await q(
      `SELECT * FROM licenses WHERE tenant_id=$1 AND module_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [tenant_id, module_id]
    ))[0];

    await logActivation(final.id, 'activated', req, { granted_by: req.user?.id, type, module_code: mc.code });
    await logAction({ user: req.user, action: 'licenses.grant', entity: 'licenses', entity_id: final.id,
                      meta: { tenant_id, module_code: mc.code, type }, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, license: final });
  } catch (e) {
    console.error('[licenses/admin/grant]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/:id/revoke — відкликати ліцензію */
router.post('/admin/:id/revoke', platformOnly, authManage, async (req, res) => {
  try {
    const { reason = '' } = req.body || {};
    const [lic] = await q(
      `UPDATE licenses SET status='revoked', revoked_at=now(), revoke_reason=$2, updated_at=now()
       WHERE id=$1 AND status NOT IN ('revoked')
       RETURNING *`,
      [req.params.id, reason]
    );
    if (!lic) return res.status(404).json({ error: 'license_not_found_or_already_revoked' });
    await logActivation(lic.id, 'revoked', req, { reason });
    await logAction({ user: req.user, action: 'licenses.revoke', entity: 'licenses',
                      entity_id: lic.id, meta: { reason }, ip: req.ip }).catch(() => {});
    res.json({ ok: true, license: lic });
  } catch (e) {
    console.error('[licenses/admin/revoke]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/:id/extend-trial — продовжити trial */
router.post('/admin/:id/extend-trial', platformOnly, authManage, async (req, res) => {
  try {
    const { extra_days = 14 } = req.body || {};
    const days = Math.max(1, Math.min(365, Number(extra_days)));
    const [lic] = await q(
      `UPDATE licenses
       SET expires_at = COALESCE(expires_at, now()) + ($2 || ' days')::interval,
           updated_at = now()
       WHERE id=$1 AND license_type='trial' AND status='active'
       RETURNING *`,
      [req.params.id, days]
    );
    if (!lic) return res.status(404).json({ error: 'trial_license_not_found_or_not_active' });
    await logActivation(lic.id, 'renewed', req, { extra_days: days });
    res.json({ ok: true, license: lic, extra_days: days });
  } catch (e) {
    console.error('[licenses/admin/extend-trial]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/bulk-grant — масова видача ліцензій */
router.post('/admin/bulk-grant', platformOnly, authManage, async (req, res) => {
  try {
    const { tenant_ids = [], module_id, type = 'subscription', expires_at } = req.body || {};
    if (!module_id || !Array.isArray(tenant_ids) || tenant_ids.length === 0)
      return res.status(400).json({ error: 'module_id_and_tenant_ids_required' });

    const mc = (await q(`SELECT * FROM module_catalog WHERE id=$1`, [module_id]))[0];
    if (!mc) return res.status(404).json({ error: 'module_not_found' });

    const results = [];
    for (const tid of tenant_ids.slice(0, 500)) { // max 500 за раз
      try {
        const rows = await q(
          `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at)
           VALUES ($1,$2,$3,'active',now(),$4)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tid, module_id, type, expires_at || null]
        );
        results.push({ tenant_id: tid, ok: true, created: rows.length > 0 });
      } catch (err) {
        results.push({ tenant_id: tid, ok: false, error: err.message });
      }
    }

    await logAction({ user: req.user, action: 'licenses.bulk_grant', entity: 'licenses',
                      meta: { module_code: mc.code, count: tenant_ids.length, type }, ip: req.ip }).catch(() => {});
    res.json({ ok: true, module_code: mc.code, results });
  } catch (e) {
    console.error('[licenses/admin/bulk-grant]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ── License Keys (on-premise) ─────────────────────────────────────────────

/** GET /api/licenses/admin/keys — ключі тенанта */
router.get('/admin/keys', platformOnly, authManage, async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const rows = await q(
      `SELECT id, tenant_id, jwt_payload, hardware_fingerprint, is_revoked,
              issued_at, expires_at, last_verified_at
       FROM license_keys
       WHERE ($1::uuid IS NULL OR tenant_id=$1)
       ORDER BY issued_at DESC LIMIT 100`,
      [tenant_id || null]
    );
    res.json({ count: rows.length, rows });
  } catch (e) {
    console.error('[licenses/admin/keys]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/keys/generate — генерувати on-premise ключ */
router.post('/admin/keys/generate', platformOnly, authManage, async (req, res) => {
  try {
    const { tenant_id, modules = [], expires_at, max_employees = 50, hardware_id } = req.body || {};
    if (!tenant_id || modules.length === 0)
      return res.status(400).json({ error: 'tenant_id_and_modules_required' });

    const expiry = expires_at ? new Date(expires_at) : new Date(Date.now() + 365 * 86400_000);
    const payload = {
      tenant_id, modules, expires_at: expiry.toISOString(),
      max_employees, hardware_id: hardware_id || null,
      issued_at: new Date().toISOString(),
    };

    const key = generateLicenseKey(payload);
    const keyHash = hashKey(key);

    const [row] = await q(
      `INSERT INTO license_keys (tenant_id, key_hash, jwt_payload, hardware_fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key_hash) DO NOTHING
       RETURNING id, tenant_id, jwt_payload, hardware_fingerprint, issued_at, expires_at`,
      [tenant_id, keyHash, JSON.stringify(payload), hardware_id || null, expiry]
    );

    await logAction({ user: req.user, action: 'licenses.key_generated', entity: 'license_keys',
                      entity_id: row?.id, meta: { tenant_id, modules }, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, key, record: row });
  } catch (e) {
    console.error('[licenses/admin/keys/generate]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/admin/keys/:id/revoke — відкликати ключ */
router.post('/admin/keys/:id/revoke', platformOnly, authManage, async (req, res) => {
  try {
    const [row] = await q(
      `UPDATE license_keys SET is_revoked=true WHERE id=$1 AND is_revoked=false RETURNING id`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'key_not_found_or_already_revoked' });
    await logAction({ user: req.user, action: 'licenses.key_revoked', entity: 'license_keys',
                      entity_id: row.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, id: row.id });
  } catch (e) {
    console.error('[licenses/admin/keys/revoke]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

/** POST /api/licenses/keys/verify — верифікувати on-premise ключ (публічний endpoint) */
router.post('/keys/verify', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key_required' });

    const keyHash = hashKey(String(key));
    const [record] = await q(
      `SELECT * FROM license_keys WHERE key_hash=$1`, [keyHash]
    );
    if (!record) return res.status(401).json({ valid: false, error: 'key_not_found' });
    if (record.is_revoked) return res.status(403).json({ valid: false, error: 'key_revoked' });
    if (record.expires_at && new Date(record.expires_at) < new Date())
      return res.status(403).json({ valid: false, error: 'key_expired' });

    // Оновити last_verified_at
    await q(`UPDATE license_keys SET last_verified_at=now() WHERE id=$1`, [record.id]).catch(() => {});

    res.json({ valid: true, payload: record.jwt_payload, expires_at: record.expires_at });
  } catch (e) {
    console.error('[licenses/keys/verify]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ── Dashboard stats (admin) ───────────────────────────────────────────────

/** GET /api/licenses/admin/stats — дашборд */
router.get('/admin/stats', platformOnly, authManage, async (req, res) => {
  try {
    const [totals] = await q(
      `SELECT
         COUNT(*)                                            AS total,
         COUNT(*) FILTER (WHERE status='active')            AS active,
         COUNT(*) FILTER (WHERE license_type='trial')       AS trials,
         COUNT(*) FILTER (WHERE license_type='subscription')AS subscriptions,
         COUNT(*) FILTER (WHERE license_type='perpetual')   AS perpetual,
         COUNT(*) FILTER (WHERE status='grace_period')      AS grace_period,
         COUNT(*) FILTER (WHERE license_type='trial'
           AND status='active'
           AND expires_at <= now() + interval '3 days')     AS trials_expiring_soon
       FROM licenses`
    );
    const topModules = await q(
      `SELECT mc.code, mc.name, mc.category,
              COUNT(*) FILTER (WHERE l.status='active') AS active_count
       FROM licenses l JOIN module_catalog mc ON mc.id=l.module_id
       GROUP BY mc.id, mc.code, mc.name, mc.category
       ORDER BY active_count DESC LIMIT 10`
    );
    const gracePeriod = await q(
      `SELECT l.id, l.tenant_id, mc.code, mc.name AS module_name, l.expires_at, l.grace_period_ends
       FROM licenses l JOIN module_catalog mc ON mc.id=l.module_id
       WHERE l.status='grace_period'
       ORDER BY l.grace_period_ends NULLS LAST LIMIT 20`
    );
    res.json({ totals, top_modules: topModules, grace_period_expiring: gracePeriod });
  } catch (e) {
    console.error('[licenses/admin/stats]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

module.exports = router;
