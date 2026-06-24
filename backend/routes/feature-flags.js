/* ═══════════════════════════════════════════════════════════════════
   SAS-10 Feature Flags v2
   Монтується як /api/v2 → покриває:
     /api/v2/internal/flags/…   (SDK, server-to-server)
     /api/v2/tenant/flags/…     (клієнтський SDK)
     /api/v2/admin/flags/…      (суперадмін)

   Пріоритетний ланцюжок evaluate:
     kill_switch → per-tenant override (expires!) → rollout % → plan_gate → default
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();
const { getPool }                       = require('../db-pg');
const { requirePerm, requirePlatform }  = require('../lib/rbac');

const pool = getPool();
const q    = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/* ── helpers ─────────────────────────────────────────────────────── */

function err500(res, e) {
  console.error('[feature-flags]', e.message);
  const msg = process.env.NODE_ENV === 'production' ? 'internal_error' : e.message;
  return res.status(500).json({ error: msg });
}

// Deterministic hash → 0..99 (used for rollout % and sticky assignment)
function tenantHash(tenantId, flagKey) {
  const str = `${tenantId}:${flagKey}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return Math.abs(h) % 100;
}

// Core evaluate function — returns { enabled, variant, reason }
async function evaluateFlag(flagKey, tenantId) {
  const flags = await q(
    `SELECT f.*, p.id AS parent_id, p.kill_switch AS parent_ks
     FROM feature_flags f
     LEFT JOIN feature_flags p ON p.id = f.parent_flag_id
     WHERE f.key = $1 LIMIT 1`,
    [flagKey]
  );
  if (!flags.length) return { enabled: false, variant: null, reason: 'flag_not_found' };
  const f = flags[0];

  if (f.status === 'archived') return { enabled: false, variant: null, reason: 'archived' };

  // 1. Kill switch
  if (f.kill_switch) return { enabled: false, variant: null, reason: 'kill_switch' };

  // 2. Parent kill switch
  if (f.parent_ks) return { enabled: false, variant: null, reason: 'parent_kill_switch' };

  // 3. Per-tenant override (check expiry)
  if (tenantId) {
    const ov = await q(
      `SELECT enabled, variant FROM feature_flag_overrides
       WHERE flag_id=$1 AND tenant_id=$2
         AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
      [f.id, tenantId]
    );
    if (ov.length) {
      return { enabled: ov[0].enabled, variant: ov[0].variant || null, reason: 'tenant_override' };
    }
  }

  // 4. Active rollout percentage
  const rollout = await q(
    `SELECT current_percent FROM feature_rollouts WHERE flag_id=$1 AND status='in_progress' LIMIT 1`,
    [f.id]
  );
  if (rollout.length && tenantId) {
    const pct = rollout[0].current_percent;
    const hash = tenantHash(tenantId, flagKey);
    const enabled = hash < pct;
    return { enabled, variant: null, reason: `rollout_${pct}pct` };
  }

  // 5. Rules (priority ASC = higher priority first)
  if (tenantId) {
    const rules = await q(
      `SELECT rule_type, conditions, value FROM feature_flag_rules
       WHERE flag_id=$1 AND enabled=true ORDER BY priority ASC`,
      [f.id]
    );
    for (const r of rules) {
      const cond = r.conditions || {};
      if (r.rule_type === 'percentage') {
        const pct = cond.percent || 0;
        if (tenantHash(tenantId, flagKey) < pct) {
          const val = typeof r.value === 'boolean' ? r.value : r.value?.valueOf?.() ?? true;
          return { enabled: !!val, variant: r.value?.variant || null, reason: 'rule_percentage' };
        }
      } else if (r.rule_type === 'time_based') {
        const now = new Date();
        const from = cond.start ? new Date(cond.start) : null;
        const till = cond.end   ? new Date(cond.end)   : null;
        const active = (!from || now >= from) && (!till || now <= till);
        if (active) {
          return { enabled: true, variant: null, reason: 'rule_time_based' };
        }
      } else if (r.rule_type === 'plan_gate') {
        // plan_gate: { min_tier: 2 } — needs tenant license context (best-effort)
        try {
          const lic = await q(
            `SELECT plan_code FROM tenant_licenses WHERE tenant_id=$1 LIMIT 1`, [tenantId]
          );
          const planMap = { solo: 1, starter: 1, pro: 2, business: 3, enterprise: 4 };
          const tier = lic.length ? (planMap[lic[0].plan_code] || 0) : 0;
          if (tier >= (cond.min_tier || 0)) {
            return { enabled: true, variant: null, reason: 'rule_plan_gate' };
          }
        } catch (_) { /* graceful */ }
      }
    }
  }

  // 6. Default
  return { enabled: !!f.default_enabled, variant: null, reason: 'default' };
}

// Audit helper
async function audit(flagId, action, actorId, prev, next, details = {}) {
  try {
    await q(
      `INSERT INTO feature_flag_audit(flag_id,action,actor_id,previous_value,new_value,details)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [flagId, action, actorId || null,
       prev  ? JSON.stringify(prev) : null,
       next  ? JSON.stringify(next) : null,
       JSON.stringify(details)]
    );
  } catch (_) { /* non-blocking */ }
}

/* ══════════════════════════════════════════════════════════════════
   INTERNAL SDK  /internal/flags/…
══════════════════════════════════════════════════════════════════ */
const internalRouter = express.Router();

// GET /internal/flags/evaluate?tenant_id=&keys=f1,f2,f3
internalRouter.get('/evaluate', async (req, res) => {
  try {
    const { tenant_id, keys } = req.query;
    if (!keys) return res.status(400).json({ error: 'keys_required' });
    const keyArr = keys.split(',').map(k => k.trim()).filter(Boolean);
    const result = {};
    for (const k of keyArr) {
      const ev = await evaluateFlag(k, tenant_id);
      result[k] = ev.enabled;
    }
    res.json(result);
  } catch (e) { return err500(res, e); }
});

// GET /internal/flags/evaluate-all?tenant_id=
internalRouter.get('/evaluate-all', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const flags = await q(`SELECT key FROM feature_flags WHERE status != 'archived' ORDER BY key`);
    const result = {};
    for (const f of flags) {
      const ev = await evaluateFlag(f.key, tenant_id);
      result[f.key] = ev.enabled;
    }
    res.json(result);
  } catch (e) { return err500(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   TENANT API  /tenant/flags/…
══════════════════════════════════════════════════════════════════ */
const tenantRouter = express.Router();
tenantRouter.use(requirePerm('saas.read'));

// GET /tenant/flags — все флаги текущего тенанта
tenantRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenant_id;
    const flags = await q(`SELECT key FROM feature_flags WHERE status != 'archived' ORDER BY key`);
    const result = {};
    for (const f of flags) {
      const ev = await evaluateFlag(f.key, tenantId);
      result[f.key] = ev.enabled;
    }
    res.json(result);
  } catch (e) { return err500(res, e); }
});

// GET /tenant/flags/:key
tenantRouter.get('/:key', async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenant_id;
    const ev = await evaluateFlag(req.params.key, tenantId);
    res.json({ enabled: ev.enabled, variant: ev.variant });
  } catch (e) { return err500(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   ADMIN API  /admin/flags/…
══════════════════════════════════════════════════════════════════ */
const adminRouter = express.Router();
const platformOnly = requirePlatform();

// Read: saas.read; Write: platformOnly (superadmin only)
adminRouter.use((req, res, next) => {
  if (req.method === 'GET') return requirePerm('saas.read')(req, res, next);
  return platformOnly(req, res, next);
});

/* ── Flag CRUD ─────────────────────────────────────────────────── */

// GET /admin/flags?module=&status=&search=&page=
adminRouter.get('/', async (req, res) => {
  try {
    const { module: mod, status, search, page = 1 } = req.query;
    const limit = 50, offset = (Number(page) - 1) * limit;
    const where = ['1=1'];
    const params = [];
    if (mod)    { params.push(mod);            where.push(`module_code=$${params.length}`); }
    if (status) { params.push(status);         where.push(`status=$${params.length}::flag_status_enum`); }
    if (search) { params.push(`%${search}%`);  where.push(`(key ILIKE $${params.length} OR name ILIKE $${params.length})`); }
    params.push(limit, offset);
    const rows = await q(
      `SELECT id,key,name,flag_type,module_code,status,default_enabled,kill_switch,
              kill_switch_at,tags,created_at,updated_at
       FROM feature_flags
       WHERE ${where.join(' AND ')}
       ORDER BY key
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ rows, page: Number(page), limit });
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags
adminRouter.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.key || !b.name) return res.status(400).json({ error: 'key_and_name_required' });
    const row = (await q(
      `INSERT INTO feature_flags
         (key,name,description,flag_type,module_code,owner,status,default_enabled,tags,metadata)
       VALUES($1,$2,$3,$4::flag_type_enum,$5,$6,$7::flag_status_enum,$8,$9,$10)
       RETURNING *`,
      [b.key, b.name, b.description || null,
       b.flag_type || 'boolean', b.module_code || null, b.owner || null,
       b.status || 'draft', b.default_enabled !== false,
       b.tags || [], JSON.stringify(b.metadata || {})]
    ))[0];
    await audit(row.id, 'created', req.user?.id, null, row);
    res.status(201).json(row);
  } catch (e) { return err500(res, e); }
});

// GET /admin/flags/:id
adminRouter.get('/:id', async (req, res) => {
  try {
    const flag = (await q(`SELECT * FROM feature_flags WHERE id=$1`, [req.params.id]))[0];
    if (!flag) return res.status(404).json({ error: 'not_found' });
    const [rules, overrides, rollout] = await Promise.all([
      q(`SELECT * FROM feature_flag_rules WHERE flag_id=$1 ORDER BY priority`, [flag.id]),
      q(`SELECT * FROM feature_flag_overrides WHERE flag_id=$1 ORDER BY created_at DESC LIMIT 20`, [flag.id]),
      q(`SELECT * FROM feature_rollouts WHERE flag_id=$1 ORDER BY created_at DESC LIMIT 1`, [flag.id]),
    ]);
    res.json({ ...flag, rules, overrides, rollout: rollout[0] || null });
  } catch (e) { return err500(res, e); }
});

// PUT /admin/flags/:id
adminRouter.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const prev = (await q(`SELECT * FROM feature_flags WHERE id=$1`, [req.params.id]))[0];
    if (!prev) return res.status(404).json({ error: 'not_found' });
    const row = (await q(
      `UPDATE feature_flags
       SET name=$2, description=$3, module_code=$4, owner=$5,
           default_enabled=$6, tags=$7, metadata=$8, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id,
       b.name        ?? prev.name,
       b.description ?? prev.description,
       b.module_code ?? prev.module_code,
       b.owner       ?? prev.owner,
       b.default_enabled !== undefined ? b.default_enabled : prev.default_enabled,
       b.tags        ?? prev.tags,
       JSON.stringify(b.metadata ?? prev.metadata)]
    ))[0];
    await audit(row.id, 'updated', req.user?.id, prev, row);
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// DELETE /admin/flags/:id  → archive (soft)
adminRouter.delete('/:id', async (req, res) => {
  try {
    const prev = (await q(`SELECT * FROM feature_flags WHERE id=$1`, [req.params.id]))[0];
    if (!prev) return res.status(404).json({ error: 'not_found' });
    await q(`UPDATE feature_flags SET status='archived', updated_at=now() WHERE id=$1`, [req.params.id]);
    await audit(prev.id, 'deleted', req.user?.id, prev, { status: 'archived' });
    res.status(204).end();
  } catch (e) { return err500(res, e); }
});

/* ── Kill Switch ───────────────────────────────────────────────── */

// POST /admin/flags/:id/kill-switch  { enabled, reason }
adminRouter.post('/:id/kill-switch', async (req, res) => {
  try {
    const { enabled, reason } = req.body || {};
    if (enabled === undefined) return res.status(400).json({ error: 'enabled_required' });
    if (enabled && !reason)   return res.status(400).json({ error: 'reason_required_for_kill_switch' });
    const prev = (await q(`SELECT * FROM feature_flags WHERE id=$1`, [req.params.id]))[0];
    if (!prev) return res.status(404).json({ error: 'not_found' });
    const row = (await q(
      `UPDATE feature_flags
       SET kill_switch=$2, kill_switch_reason=$3,
           kill_switch_at = CASE WHEN $2 THEN now() ELSE NULL END,
           updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, !!enabled, reason || null]
    ))[0];
    const action = enabled ? 'kill_switch_on' : 'kill_switch_off';
    await audit(row.id, action, req.user?.id, { kill_switch: prev.kill_switch }, { kill_switch: enabled, reason });
    res.json({ id: row.id, key: row.key, kill_switch: row.kill_switch, kill_switch_at: row.kill_switch_at });
  } catch (e) { return err500(res, e); }
});

/* ── Rules ─────────────────────────────────────────────────────── */

// GET /admin/flags/:id/rules
adminRouter.get('/:id/rules', async (req, res) => {
  try {
    const rows = await q(
      `SELECT * FROM feature_flag_rules WHERE flag_id=$1 ORDER BY priority`, [req.params.id]
    );
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/:id/rules
adminRouter.post('/:id/rules', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.rule_type) return res.status(400).json({ error: 'rule_type_required' });
    const row = (await q(
      `INSERT INTO feature_flag_rules(flag_id,rule_type,priority,enabled,conditions,value,description)
       VALUES($1,$2::rule_type_enum,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, b.rule_type, b.priority || 0, b.enabled !== false,
       JSON.stringify(b.conditions || {}), JSON.stringify(b.value ?? true), b.description || null]
    ))[0];
    await audit(Number(req.params.id), 'rule_added', req.user?.id, null, row);
    res.status(201).json(row);
  } catch (e) { return err500(res, e); }
});

// PUT /admin/flags/:id/rules/:ruleId
adminRouter.put('/:id/rules/:ruleId', async (req, res) => {
  try {
    const b = req.body || {};
    const prev = (await q(`SELECT * FROM feature_flag_rules WHERE id=$1 AND flag_id=$2`, [req.params.ruleId, req.params.id]))[0];
    if (!prev) return res.status(404).json({ error: 'rule_not_found' });
    const row = (await q(
      `UPDATE feature_flag_rules
       SET priority=$3, enabled=$4, conditions=$5, value=$6, description=$7, updated_at=now()
       WHERE id=$1 AND flag_id=$2 RETURNING *`,
      [req.params.ruleId, req.params.id,
       b.priority    ?? prev.priority,
       b.enabled     !== undefined ? b.enabled : prev.enabled,
       JSON.stringify(b.conditions ?? prev.conditions),
       JSON.stringify(b.value      ?? prev.value),
       b.description ?? prev.description]
    ))[0];
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// DELETE /admin/flags/:id/rules/:ruleId
adminRouter.delete('/:id/rules/:ruleId', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM feature_flag_rules WHERE id=$1 AND flag_id=$2`, [req.params.ruleId, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'rule_not_found' });
    res.status(204).end();
  } catch (e) { return err500(res, e); }
});

/* ── Overrides ─────────────────────────────────────────────────── */

// GET /admin/flags/:id/overrides?tenant_id=&page=
adminRouter.get('/:id/overrides', async (req, res) => {
  try {
    const { tenant_id, page = 1 } = req.query;
    const limit = 50, offset = (Number(page) - 1) * limit;
    const where = ['flag_id=$1'];
    const params = [req.params.id];
    if (tenant_id) { params.push(tenant_id); where.push(`tenant_id=$${params.length}`); }
    params.push(limit, offset);
    const rows = await q(
      `SELECT * FROM feature_flag_overrides
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/:id/overrides  { tenant_id, enabled, reason, expires_at? }
adminRouter.post('/:id/overrides', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.tenant_id || b.enabled === undefined) {
      return res.status(400).json({ error: 'tenant_id_and_enabled_required' });
    }
    const row = (await q(
      `INSERT INTO feature_flag_overrides(flag_id,tenant_id,enabled,variant,reason,expires_at,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(flag_id,tenant_id)
       DO UPDATE SET enabled=$3, variant=$4, reason=$5, expires_at=$6, updated_at=now()
       RETURNING *`,
      [req.params.id, b.tenant_id, !!b.enabled,
       b.variant || null, b.reason || null,
       b.expires_at || null, req.user?.id || null]
    ))[0];
    await audit(Number(req.params.id), 'override_added', req.user?.id, null,
      { tenant_id: b.tenant_id, enabled: b.enabled });
    res.status(201).json(row);
  } catch (e) { return err500(res, e); }
});

// DELETE /admin/flags/:id/overrides/:tenantId
adminRouter.delete('/:id/overrides/:tenantId', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM feature_flag_overrides WHERE flag_id=$1 AND tenant_id=$2`,
      [req.params.id, req.params.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'override_not_found' });
    await audit(Number(req.params.id), 'override_removed', req.user?.id,
      { tenant_id: req.params.tenantId }, null);
    res.status(204).end();
  } catch (e) { return err500(res, e); }
});

/* ── Rollout ───────────────────────────────────────────────────── */

// POST /admin/flags/:id/rollout  { stages[], auto_pause_rules? }
adminRouter.post('/:id/rollout', async (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.stages) || !b.stages.length) {
      return res.status(400).json({ error: 'stages_array_required' });
    }
    // Only one active rollout per flag
    await q(`UPDATE feature_rollouts SET status='rolled_back', updated_at=now()
             WHERE flag_id=$1 AND status IN ('planned','in_progress','paused')`, [req.params.id]);
    const row = (await q(
      `INSERT INTO feature_rollouts(flag_id,status,stages,current_stage,current_percent,auto_pause_rules,created_by)
       VALUES($1,'planned',$2,0,0,$3,$4) RETURNING *`,
      [req.params.id, JSON.stringify(b.stages),
       JSON.stringify(b.auto_pause_rules || {}), req.user?.id || null]
    ))[0];
    await audit(Number(req.params.id), 'rollout_started', req.user?.id, null, { stages: b.stages });
    res.status(201).json(row);
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/:id/rollout/advance
adminRouter.post('/:id/rollout/advance', async (req, res) => {
  try {
    const ro = (await q(
      `SELECT * FROM feature_rollouts WHERE flag_id=$1 AND status IN ('planned','in_progress') LIMIT 1`,
      [req.params.id]
    ))[0];
    if (!ro) return res.status(404).json({ error: 'no_active_rollout' });
    const stages = ro.stages || [];
    const nextStage = ro.current_stage + 1;
    if (nextStage >= stages.length) {
      // All done
      const row = (await q(
        `UPDATE feature_rollouts SET status='completed', current_percent=100,
         current_stage=$2, completed_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [ro.id, nextStage]
      ))[0];
      // Apply to flag default
      await q(`UPDATE feature_flags SET default_enabled=true, updated_at=now() WHERE id=$1`, [req.params.id]);
      await audit(Number(req.params.id), 'rollout_completed', req.user?.id, null, { stage: nextStage });
      return res.json(row);
    }
    const pct = stages[nextStage]?.percent ?? 100;
    const row = (await q(
      `UPDATE feature_rollouts SET status='in_progress', current_stage=$2, current_percent=$3,
       updated_at=now() WHERE id=$1 RETURNING *`,
      [ro.id, nextStage, pct]
    ))[0];
    await audit(Number(req.params.id), 'rollout_advanced', req.user?.id,
      { stage: ro.current_stage, percent: ro.current_percent }, { stage: nextStage, percent: pct });
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/:id/rollout/pause  { reason }
adminRouter.post('/:id/rollout/pause', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const row = (await q(
      `UPDATE feature_rollouts SET status='paused', paused_at=now(), pause_reason=$2, updated_at=now()
       WHERE flag_id=$1 AND status='in_progress' RETURNING *`,
      [req.params.id, reason || null]
    ))[0];
    if (!row) return res.status(404).json({ error: 'no_in_progress_rollout' });
    await audit(Number(req.params.id), 'rollout_paused', req.user?.id, null, { reason });
    res.json(row);
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/:id/rollout/rollback
adminRouter.post('/:id/rollout/rollback', async (req, res) => {
  try {
    const ro = (await q(
      `SELECT * FROM feature_rollouts WHERE flag_id=$1 AND status IN ('in_progress','paused') LIMIT 1`,
      [req.params.id]
    ))[0];
    if (!ro) return res.status(404).json({ error: 'no_active_rollout' });
    const prevStage = Math.max(0, ro.current_stage - 1);
    const stages = ro.stages || [];
    const pct = prevStage === 0 ? 0 : (stages[prevStage]?.percent ?? 0);
    const row = (await q(
      `UPDATE feature_rollouts SET status='rolled_back', current_stage=$2, current_percent=$3, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [ro.id, prevStage, pct]
    ))[0];
    await audit(Number(req.params.id), 'rollout_rolled_back', req.user?.id,
      { stage: ro.current_stage }, { stage: prevStage, percent: pct });
    res.json(row);
  } catch (e) { return err500(res, e); }
});

/* ── Audit Log ─────────────────────────────────────────────────── */

// GET /admin/flags/:id/audit?page=
adminRouter.get('/:id/audit', async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = 50, offset = (Number(page) - 1) * limit;
    const rows = await q(
      `SELECT * FROM feature_flag_audit WHERE flag_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ rows, page: Number(page) });
  } catch (e) { return err500(res, e); }
});

/* ── Kill Switch Dashboard ─────────────────────────────────────── */

// GET /admin/kill-switches  — все активные kill switches
adminRouter.get('/kill-switches', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id,key,name,module_code,kill_switch_reason,kill_switch_at
       FROM feature_flags WHERE kill_switch=true ORDER BY kill_switch_at DESC`
    );
    res.json({ rows, total: rows.length });
  } catch (e) { return err500(res, e); }
});

/* ── Import / Export ───────────────────────────────────────────── */

// GET /admin/flags/export
adminRouter.get('/export', async (req, res) => {
  try {
    const flags = await q(`SELECT * FROM feature_flags WHERE status != 'archived' ORDER BY key`);
    const rules = await q(`SELECT * FROM feature_flag_rules ORDER BY flag_id, priority`);
    res.json({ exported_at: new Date().toISOString(), flags, rules });
  } catch (e) { return err500(res, e); }
});

// POST /admin/flags/import  { flags: [...] }  (upsert)
adminRouter.post('/import', async (req, res) => {
  try {
    const flags = req.body?.flags;
    if (!Array.isArray(flags)) return res.status(400).json({ error: 'flags_array_required' });
    let imported = 0;
    for (const f of flags) {
      if (!f.key || !f.name) continue;
      await q(
        `INSERT INTO feature_flags(key,name,description,flag_type,module_code,default_enabled,tags)
         VALUES($1,$2,$3,$4::flag_type_enum,$5,$6,$7)
         ON CONFLICT(key) DO UPDATE SET
           name=$2, description=$3, module_code=$5, default_enabled=$6, updated_at=now()`,
        [f.key, f.name, f.description || null, f.flag_type || 'boolean',
         f.module_code || null, f.default_enabled !== false, f.tags || []]
      );
      imported++;
    }
    res.json({ imported });
  } catch (e) { return err500(res, e); }
});

/* ── Wire sub-routers ──────────────────────────────────────────── */

router.use('/internal/flags', internalRouter);
router.use('/tenant/flags',   tenantRouter);
router.use('/admin/flags',    adminRouter);

module.exports = router;
