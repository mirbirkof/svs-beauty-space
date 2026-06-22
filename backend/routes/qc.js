/* routes/qc.js — MGT-05 Контроль якості.
   Стандарти якості, чек-листи+пункти, перевірки (аудити) з авто-підрахунком балу,
   невідповідності+CAPA (можуть породити задачу MGT-01), таємний покупець, KPI якості
   по майстрах. Прагматика під один салон. Доступ: GET=qc.read, мутації=qc.write. */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
let emit = async () => {}; try { ({ emit } = require('../lib/event-bus')); } catch { /* optional */ }

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const num = (v) => (v == null || v === '' ? null : Number(v));

const STD_CATEGORIES = ['hygiene', 'procedure', 'service', 'facility', 'appearance', 'safety'];
const CHECKLIST_TYPES = ['daily', 'procedure', 'general', 'mystery_shopper'];
const SEVERITIES = ['minor', 'major', 'critical'];
const NC_STATUSES = ['open', 'in_progress', 'corrected', 'verified', 'closed'];

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'qc.read' : 'qc.write';
  return requirePerm(perm)(req, res, next);
});

// нормалізує оцінку пункту в бал 0..1 з урахуванням типу
function normScore(evaluation, evalType) {
  if (evaluation === 'na') return null;       // не враховується
  if (evalType === 'pass_fail') return evaluation === 'pass' ? 1 : 0;
  const n = Number(evaluation);
  if (Number.isNaN(n)) return evaluation === 'pass' ? 1 : 0;
  if (evalType === 'score_5') return Math.max(0, Math.min(1, n / 5));
  if (evalType === 'score_10') return Math.max(0, Math.min(1, n / 10));
  return Math.max(0, Math.min(1, n));
}
function resultTier(pct) {
  if (pct >= 95) return 'excellent';
  if (pct >= 80) return 'good';
  if (pct >= 60) return 'satisfactory';
  return 'unsatisfactory';
}

// ─────────────────────────── СТАНДАРТИ ───────────────────────────

router.get('/standards', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.category) { p.push(req.query.category); w.push(`category=$${p.length}`); }
    if (req.query.status) { p.push(req.query.status); w.push(`status=$${p.length}`); }
    if (req.query.branch_id) { p.push(num(req.query.branch_id)); w.push(`branch_id=$${p.length}`); }
    if (req.query.search) { p.push('%' + req.query.search + '%'); w.push(`(title ILIKE $${p.length} OR description ILIKE $${p.length})`); }
    const items = await q(`SELECT * FROM qc_standards WHERE ${w.join(' AND ')} ORDER BY id DESC`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/standards/:id(\\d+)', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM qc_standards WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/standards', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title required' });
    const cat = STD_CATEGORIES.includes(b.category) ? b.category : 'service';
    const row = (await q(
      `INSERT INTO qc_standards (branch_id,title,description,category,applicable_services,photo_correct_url,photo_incorrect_url,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [num(b.branch_id), b.title, b.description || '', cat,
       b.applicable_services ? JSON.stringify(b.applicable_services) : null,
       b.photo_correct_url || null, b.photo_incorrect_url || null, b.status || 'draft']))[0];
    await logAction({ user: req.user, action: 'qc.standard.create', entity: 'qc_standard', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/standards/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const f = []; const p = [];
    const set = (c, v, j) => { p.push(j && v != null ? JSON.stringify(v) : v); f.push(`${c}=$${p.length}${j ? '::jsonb' : ''}`); };
    if (b.title != null) set('title', b.title);
    if (b.description != null) set('description', b.description);
    if (b.category != null && STD_CATEGORIES.includes(b.category)) set('category', b.category);
    if (b.applicable_services !== undefined) set('applicable_services', b.applicable_services, true);
    if (b.photo_correct_url !== undefined) set('photo_correct_url', b.photo_correct_url);
    if (b.photo_incorrect_url !== undefined) set('photo_incorrect_url', b.photo_incorrect_url);
    if (b.status != null) set('status', b.status);
    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    // оновлення = нова версія
    f.push('version=version+1');
    p.push(req.params.id);
    const row = (await q(`UPDATE qc_standards SET ${f.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── ЧЕК-ЛИСТИ ───────────────────────────

router.get('/checklists', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.type) { p.push(req.query.type); w.push(`checklist_type=$${p.length}`); }
    if (req.query.role) { p.push(req.query.role); w.push(`applicable_role=$${p.length}`); }
    if (req.query.service_id) { p.push(num(req.query.service_id)); w.push(`applicable_service_id=$${p.length}`); }
    if (req.query.active != null) { p.push(req.query.active === 'true' || req.query.active === '1'); w.push(`active=$${p.length}`); }
    const items = await q(
      `SELECT c.*, (SELECT COUNT(*) FROM qc_checklist_items i WHERE i.checklist_id=c.id)::int items_count
       FROM qc_checklists c WHERE ${w.join(' AND ')} ORDER BY c.id DESC`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/checklists/:id(\\d+)', async (req, res) => {
  try {
    const checklist = (await q(`SELECT * FROM qc_checklists WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!checklist) return res.status(404).json({ error: 'not found' });
    const items = await q(`SELECT * FROM qc_checklist_items WHERE checklist_id=$1 ORDER BY sort_order, id`, [checklist.id]);
    res.json({ checklist, items });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/checklists', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.title) { client.release(); return res.status(400).json({ error: 'title required' }); }
    const type = CHECKLIST_TYPES.includes(b.checklist_type) ? b.checklist_type : 'general';
    await client.query('BEGIN'); await applyTenant(client);
    const cl = (await client.query(
      `INSERT INTO qc_checklists (branch_id,title,description,checklist_type,applicable_role,applicable_service_id,pass_threshold,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true)) RETURNING *`,
      [num(b.branch_id), b.title, b.description || '', type, b.applicable_role || null,
       num(b.applicable_service_id), num(b.pass_threshold) ?? 80, b.active])).rows[0];
    let totalWeight = 0;
    const items = Array.isArray(b.items) ? b.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]; const wgt = num(it.weight) ?? 1; totalWeight += wgt;
      await client.query(
        `INSERT INTO qc_checklist_items (checklist_id,standard_id,text,category,weight,requires_photo,evaluation_type,sort_order,tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [cl.id, num(it.standard_id), it.text, it.category || null, wgt, !!it.requires_photo,
         it.evaluation_type || 'pass_fail', it.sort_order != null ? num(it.sort_order) : i, cl.tenant_id]);
    }
    await client.query(`UPDATE qc_checklists SET total_weight=$1 WHERE id=$2`, [totalWeight, cl.id]);
    await client.query('COMMIT');
    client.release();
    await logAction({ user: req.user, action: 'qc.checklist.create', entity: 'qc_checklist', entity_id: cl.id, ip: req.ip });
    res.status(201).json({ ...cl, total_weight: totalWeight, items_count: items.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

router.patch('/checklists/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const f = []; const p = [];
    const set = (c, v) => { p.push(v); f.push(`${c}=$${p.length}`); };
    if (b.title != null) set('title', b.title);
    if (b.description != null) set('description', b.description);
    if (b.applicable_role !== undefined) set('applicable_role', b.applicable_role);
    if (b.applicable_service_id !== undefined) set('applicable_service_id', num(b.applicable_service_id));
    if (b.pass_threshold != null) set('pass_threshold', num(b.pass_threshold));
    if (b.active != null) set('active', !!b.active);
    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(`UPDATE qc_checklists SET ${f.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// додати пункт до існуючого чек-листа
router.post('/checklists/:id(\\d+)/items', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.text) return res.status(400).json({ error: 'text required' });
    const ord = b.sort_order != null ? num(b.sort_order)
      : ((await q(`SELECT COALESCE(MAX(sort_order),-1)+1 n FROM qc_checklist_items WHERE checklist_id=$1`, [req.params.id]))[0].n);
    const row = (await q(
      `INSERT INTO qc_checklist_items (checklist_id,standard_id,text,category,weight,requires_photo,evaluation_type,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, num(b.standard_id), b.text, b.category || null, num(b.weight) ?? 1,
       !!b.requires_photo, b.evaluation_type || 'pass_fail', ord]))[0];
    await q(`UPDATE qc_checklists SET total_weight=(SELECT COALESCE(SUM(weight),0) FROM qc_checklist_items WHERE checklist_id=$1), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/checklists/:id(\\d+)/items/:itemId(\\d+)', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM qc_checklist_items WHERE id=$1 AND checklist_id=$2 RETURNING id`, [req.params.itemId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await q(`UPDATE qc_checklists SET total_weight=(SELECT COALESCE(SUM(weight),0) FROM qc_checklist_items WHERE checklist_id=$1), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── ПЕРЕВІРКИ ───────────────────────────

router.get('/checks', async (req, res) => {
  try {
    const w = ['ch.tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.checklist_id) add('ch.checklist_id=?', num(req.query.checklist_id));
    if (req.query.status) add('ch.status=?', req.query.status);
    if (req.query.result) add('ch.result=?', req.query.result);
    if (req.query.inspector_id) add('ch.inspector_id=?', num(req.query.inspector_id));
    if (req.query.employee_id) add('ch.inspected_employee_id=?', num(req.query.employee_id));
    if (req.query.branch_id) add('ch.branch_id=?', num(req.query.branch_id));
    if (req.query.date_from) add('ch.scheduled_date>=?', req.query.date_from);
    if (req.query.date_to) add('ch.scheduled_date<=?', req.query.date_to);
    const limit = Math.min(300, Number(req.query.limit) || 50); const offset = Number(req.query.offset) || 0;
    p.push(limit); const li = p.length; p.push(offset); const oi = p.length;
    const items = await q(
      `SELECT ch.*, cl.title checklist_title, m.name inspected_name
       FROM qc_checks ch JOIN qc_checklists cl ON cl.id=ch.checklist_id
       LEFT JOIN masters m ON m.id=ch.inspected_employee_id
       WHERE ${w.join(' AND ')} ORDER BY ch.id DESC LIMIT $${li} OFFSET $${oi}`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/checks/:id(\\d+)', async (req, res) => {
  try {
    const check = (await q(`SELECT * FROM qc_checks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!check) return res.status(404).json({ error: 'not found' });
    const results = await q(
      `SELECT r.*, i.text item_text, i.weight, i.category, i.evaluation_type
       FROM qc_check_results r JOIN qc_checklist_items i ON i.id=r.item_id
       WHERE r.check_id=$1 ORDER BY i.sort_order`, [check.id]);
    const non_conformities = await q(`SELECT * FROM qc_non_conformities WHERE check_id=$1 ORDER BY id`, [check.id]);
    res.json({ check, results, non_conformities });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/checks', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.checklist_id) return res.status(400).json({ error: 'checklist_id required' });
    const row = (await q(
      `INSERT INTO qc_checks (branch_id,checklist_id,check_type,inspector_id,inspector_name,inspected_employee_id,inspected_zone,scheduled_date,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled') RETURNING *`,
      [num(b.branch_id), num(b.checklist_id), b.check_type === 'unplanned' ? 'unplanned' : 'planned',
       req.user?.id ?? null, req.user?.name || null, num(b.inspected_employee_id),
       b.inspected_zone || null, b.scheduled_date || null]))[0];
    await logAction({ user: req.user, action: 'qc.check.create', entity: 'qc_check', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/checks/:id(\\d+)/start', async (req, res) => {
  try {
    const row = (await q(`UPDATE qc_checks SET status='in_progress', started_at=COALESCE(started_at,NOW()), updated_at=NOW() WHERE id=$1 AND tenant_id=current_tenant_id() AND status='scheduled' RETURNING *`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found or not scheduled' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// зберегти результати (batch, upsert по item)
router.post('/checks/:id(\\d+)/results', async (req, res) => {
  const client = await pool.connect();
  try {
    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    if (!results.length) { client.release(); return res.status(400).json({ error: 'results required' }); }
    const chk = (await client.query(`SELECT id,tenant_id FROM qc_checks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id])).rows[0];
    if (!chk) { client.release(); return res.status(404).json({ error: 'not found' }); }
    await client.query('BEGIN'); await applyTenant(client);
    for (const r of results) {
      const itemId = num(r.item_id); if (!itemId) continue;
      const it = (await client.query(`SELECT evaluation_type FROM qc_checklist_items WHERE id=$1 AND checklist_id=(SELECT checklist_id FROM qc_checks WHERE id=$2)`, [itemId, chk.id])).rows[0];
      if (!it) continue;
      const sc = normScore(r.evaluation, it.evaluation_type);
      // прибрати старий результат по цьому пункту (перезапис)
      await client.query(`DELETE FROM qc_check_results WHERE check_id=$1 AND item_id=$2`, [chk.id, itemId]);
      await client.query(
        `INSERT INTO qc_check_results (check_id,item_id,evaluation,score,comment,photo_url,tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [chk.id, itemId, String(r.evaluation), sc, r.comment || null, r.photo_url || null, chk.tenant_id]);
    }
    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, saved: results.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// завершити: авто-підрахунок зваженого балу + результат
router.post('/checks/:id(\\d+)/complete', async (req, res) => {
  try {
    const chk = (await q(`SELECT * FROM qc_checks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!chk) return res.status(404).json({ error: 'not found' });
    // зважений бал: SUM(score*weight) / SUM(weight) серед НЕ-na пунктів
    const agg = (await q(
      `SELECT COALESCE(SUM(r.score*i.weight),0)::float earned,
              COALESCE(SUM(CASE WHEN r.score IS NOT NULL THEN i.weight ELSE 0 END),0)::float maxw
       FROM qc_check_results r JOIN qc_checklist_items i ON i.id=r.item_id
       WHERE r.check_id=$1`, [chk.id]))[0];
    const pct = agg.maxw > 0 ? Math.round((agg.earned / agg.maxw) * 10000) / 100 : 0;
    const tier = resultTier(pct);
    const row = (await q(
      `UPDATE qc_checks SET status='completed', completed_at=NOW(), total_score=$1, result=$2,
         inspector_notes=COALESCE($3,inspector_notes), signature_url=COALESCE($4,signature_url), updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [pct, tier, req.body?.inspector_notes || null, req.body?.signature_url || null, chk.id]))[0];
    await logAction({ user: req.user, action: 'qc.check.complete', entity: 'qc_check', entity_id: chk.id, ip: req.ip, meta: { score: pct, result: tier } });
    await emit('qc.check_completed', { id: chk.id, score: pct, result: tier, employee_id: chk.inspected_employee_id }, { entityType: 'qc_check', entityId: chk.id, actor: String(req.user?.id || 'system') });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/checks/:id(\\d+)/review', async (req, res) => {
  try {
    const row = (await q(`UPDATE qc_checks SET status='reviewed', reviewed_by=$1, reviewed_at=NOW(), updated_at=NOW() WHERE id=$2 AND tenant_id=current_tenant_id() AND status='completed' RETURNING *`, [req.user?.id ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found or not completed' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── НЕВІДПОВІДНОСТІ + CAPA ───────────────────────────

router.get('/non-conformities', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.severity) add('severity=?', req.query.severity);
    if (req.query.status) add('status=?', req.query.status);
    if (req.query.employee_id) add('employee_id=?', num(req.query.employee_id));
    if (req.query.branch_id) add('branch_id=?', num(req.query.branch_id));
    if (req.query.open === '1') w.push("status NOT IN ('verified','closed')");
    const items = await q(`SELECT * FROM qc_non_conformities WHERE ${w.join(' AND ')} ORDER BY array_position(ARRAY['critical','major','minor'],severity), (status IN ('verified','closed')), id DESC`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/non-conformities/:id(\\d+)', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM qc_non_conformities WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/non-conformities', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: 'description required' });
    const sev = SEVERITIES.includes(b.severity) ? b.severity : 'minor';
    let linkedTaskId = null;
    // авто-створення задачі MGT-01 для виправлення (якщо є виконавець або create_task=true)
    if (b.create_task !== false && (b.assignee_id || b.corrective_action)) {
      const task = (await q(
        `INSERT INTO tasks (title,description,priority,status,assignee_id,due_date,tenant_id,creator_id,creator_name)
         VALUES ($1,$2,$3,'todo',$4,$5,current_tenant_id(),$6,$7) RETURNING id`,
        [`Усунути невідповідність: ${String(b.description).slice(0, 80)}`,
         b.corrective_action || b.description, sev === 'critical' ? 'high' : sev === 'major' ? 'medium' : 'low',
         num(b.assignee_id), b.due_date || null, req.user?.id ?? null, req.user?.name || null]))[0];
      linkedTaskId = task?.id || null;
    }
    const row = (await q(
      `INSERT INTO qc_non_conformities (branch_id,check_id,mystery_report_id,check_result_id,employee_id,severity,description,corrective_action,preventive_action,assignee_id,due_date,linked_task_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open') RETURNING *`,
      [num(b.branch_id), num(b.check_id), num(b.mystery_report_id), num(b.check_result_id),
       num(b.employee_id), sev, b.description, b.corrective_action || null, b.preventive_action || null,
       num(b.assignee_id), b.due_date || null, linkedTaskId]))[0];
    await logAction({ user: req.user, action: 'qc.nc.create', entity: 'qc_nc', entity_id: row.id, ip: req.ip, meta: { severity: sev, task: linkedTaskId } });
    await emit('qc.non_conformity_created', { id: row.id, severity: sev, employee_id: row.employee_id }, { entityType: 'qc_nc', entityId: row.id, actor: String(req.user?.id || 'system') });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/non-conformities/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const f = []; const p = [];
    const set = (c, v) => { p.push(v); f.push(`${c}=$${p.length}`); };
    if (b.severity != null && SEVERITIES.includes(b.severity)) set('severity', b.severity);
    if (b.status != null && NC_STATUSES.includes(b.status)) set('status', b.status);
    if (b.description != null) set('description', b.description);
    if (b.corrective_action !== undefined) set('corrective_action', b.corrective_action);
    if (b.preventive_action !== undefined) set('preventive_action', b.preventive_action);
    if (b.assignee_id !== undefined) set('assignee_id', num(b.assignee_id));
    if (b.due_date !== undefined) set('due_date', b.due_date);
    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(`UPDATE qc_non_conformities SET ${f.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/non-conformities/:id(\\d+)/verify', async (req, res) => {
  try {
    const ok = req.body?.verified !== false;
    const row = (await q(
      `UPDATE qc_non_conformities SET status=$1, verified_by=$2, verified_at=NOW(),
         preventive_action=COALESCE($3,preventive_action), updated_at=NOW()
       WHERE id=$4 AND tenant_id=current_tenant_id() RETURNING *`,
      [ok ? 'verified' : 'in_progress', req.user?.id ?? null, req.body?.comment || null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'qc.nc.verify', entity: 'qc_nc', entity_id: row.id, ip: req.ip, meta: { verified: ok } });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── ТАЄМНИЙ ПОКУПЕЦЬ ───────────────────────────

const MS_SCORES = ['first_impression', 'greeting', 'consultation', 'procedure', 'checkout', 'farewell', 'cleanliness', 'overall_impression'];

router.get('/mystery-shopper', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.status) { p.push(req.query.status); w.push(`status=$${p.length}`); }
    if (req.query.branch_id) { p.push(num(req.query.branch_id)); w.push(`branch_id=$${p.length}`); }
    if (req.query.date_from) { p.push(req.query.date_from); w.push(`visit_date>=$${p.length}`); }
    if (req.query.date_to) { p.push(req.query.date_to); w.push(`visit_date<=$${p.length}`); }
    const items = await q(`SELECT * FROM mystery_shopper_reports WHERE ${w.join(' AND ')} ORDER BY visit_date DESC, id DESC`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/mystery-shopper/:id(\\d+)', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM mystery_shopper_reports WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

function msOverall(b) {
  const vals = MS_SCORES.map(k => num(b[k + '_score'])).filter(v => v != null);
  return vals.length ? Math.round((vals.reduce((a, c) => a + c, 0) / vals.length) * 100) / 100 : null;
}

router.post('/mystery-shopper', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.shopper_name || !b.visit_date) return res.status(400).json({ error: 'shopper_name and visit_date required' });
    const overall = msOverall(b);
    const cols = ['branch_id', 'shopper_name', 'shopper_contact', 'visit_date', 'service_id', 'employee_id', 'scenario', 'status', 'overall_score', 'recommendations'];
    const vals = [num(b.branch_id), b.shopper_name, b.shopper_contact || null, b.visit_date, num(b.service_id),
      num(b.employee_id), b.scenario || null, b.status || 'draft', overall, b.recommendations || null];
    for (const k of MS_SCORES) { cols.push(k + '_score'); vals.push(num(b[k + '_score'])); cols.push(k + '_comment'); vals.push(b[k + '_comment'] || null); }
    const ph = vals.map((_, i) => '$' + (i + 1)).join(',');
    const row = (await q(`INSERT INTO mystery_shopper_reports (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals))[0];
    await logAction({ user: req.user, action: 'qc.mystery.create', entity: 'mystery_report', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/mystery-shopper/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const f = []; const p = [];
    const set = (c, v) => { p.push(v); f.push(`${c}=$${p.length}`); };
    for (const k of ['shopper_name', 'shopper_contact', 'scenario', 'status', 'recommendations']) if (b[k] !== undefined) set(k, b[k]);
    if (b.service_id !== undefined) set('service_id', num(b.service_id));
    if (b.employee_id !== undefined) set('employee_id', num(b.employee_id));
    let touchedScore = false;
    for (const k of MS_SCORES) {
      if (b[k + '_score'] !== undefined) { set(k + '_score', num(b[k + '_score'])); touchedScore = true; }
      if (b[k + '_comment'] !== undefined) set(k + '_comment', b[k + '_comment']);
    }
    if (touchedScore) {
      const cur = (await q(`SELECT * FROM mystery_shopper_reports WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
      if (cur) { const merged = { ...cur, ...b }; set('overall_score', msOverall(merged)); }
    }
    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(`UPDATE mystery_shopper_reports SET ${f.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/mystery-shopper/:id(\\d+)/review', async (req, res) => {
  try {
    const row = (await q(`UPDATE mystery_shopper_reports SET status='reviewed', reviewed_by=$1, reviewed_at=NOW(), updated_at=NOW() WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`, [req.user?.id ?? null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── РОЗКЛАД ───────────────────────────

router.get('/schedule', async (req, res) => {
  try {
    const w = ['s.tenant_id=current_tenant_id()']; const p = [];
    if (req.query.active != null) { p.push(req.query.active === 'true' || req.query.active === '1'); w.push(`s.active=$${p.length}`); }
    if (req.query.branch_id) { p.push(num(req.query.branch_id)); w.push(`s.branch_id=$${p.length}`); }
    const items = await q(`SELECT s.*, cl.title checklist_title FROM qc_check_schedule s JOIN qc_checklists cl ON cl.id=s.checklist_id WHERE ${w.join(' AND ')} ORDER BY s.id DESC`, p);
    res.json({ items, total: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/schedule', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.checklist_id) return res.status(400).json({ error: 'checklist_id required' });
    const freq = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'weekly';
    const row = (await q(
      `INSERT INTO qc_check_schedule (branch_id,checklist_id,inspector_id,frequency,day_of_week,day_of_month,time_of_day,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true)) RETURNING *`,
      [num(b.branch_id), num(b.checklist_id), num(b.inspector_id), freq,
       num(b.day_of_week), num(b.day_of_month), b.time_of_day || null, b.active]))[0];
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/schedule/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const f = []; const p = [];
    const set = (c, v) => { p.push(v); f.push(`${c}=$${p.length}`); };
    if (b.frequency != null && ['daily', 'weekly', 'monthly'].includes(b.frequency)) set('frequency', b.frequency);
    if (b.day_of_week !== undefined) set('day_of_week', num(b.day_of_week));
    if (b.day_of_month !== undefined) set('day_of_month', num(b.day_of_month));
    if (b.time_of_day !== undefined) set('time_of_day', b.time_of_day);
    if (b.inspector_id !== undefined) set('inspector_id', num(b.inspector_id));
    if (b.active != null) set('active', !!b.active);
    if (!f.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(`UPDATE qc_check_schedule SET ${f.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────── АНАЛІТИКА ───────────────────────────

router.get('/analytics', async (req, res) => {
  try {
    const days = Math.min(366, Number(req.query.days) || 90);
    const since = `NOW() - (${days} || ' days')::interval`;
    const main = (await q(
      `SELECT ROUND(AVG(total_score)::numeric,2) avg_score, COUNT(*)::int checks_count
       FROM qc_checks WHERE tenant_id=current_tenant_id() AND status IN ('completed','reviewed') AND completed_at >= ${since}`))[0];
    const nc = (await q(
      `SELECT COUNT(*)::int nc_count,
         COUNT(*) FILTER (WHERE severity='critical')::int critical,
         COUNT(*) FILTER (WHERE severity='major')::int major,
         COUNT(*) FILTER (WHERE severity='minor')::int minor,
         COUNT(*) FILTER (WHERE status NOT IN ('verified','closed'))::int open
       FROM qc_non_conformities WHERE tenant_id=current_tenant_id() AND created_at >= ${since}`))[0];
    const topFail = await q(
      `SELECT i.text, i.category, COUNT(*)::int fails
       FROM qc_check_results r JOIN qc_checklist_items i ON i.id=r.item_id JOIN qc_checks ch ON ch.id=r.check_id
       WHERE ch.tenant_id=current_tenant_id() AND r.score IS NOT NULL AND r.score < 1 AND ch.completed_at >= ${since}
       GROUP BY i.text, i.category ORDER BY fails DESC LIMIT 10`);
    const ranking = await q(
      `SELECT ch.inspected_employee_id employee_id, m.name employee_name,
         ROUND(AVG(ch.total_score)::numeric,2) avg_score, COUNT(*)::int checks
       FROM qc_checks ch LEFT JOIN masters m ON m.id=ch.inspected_employee_id
       WHERE ch.tenant_id=current_tenant_id() AND ch.inspected_employee_id IS NOT NULL
         AND ch.status IN ('completed','reviewed') AND ch.completed_at >= ${since}
       GROUP BY ch.inspected_employee_id, m.name ORDER BY avg_score DESC NULLS LAST`);
    const trend = await q(
      `SELECT to_char(date_trunc('month',completed_at),'YYYY-MM') AS month, ROUND(AVG(total_score)::numeric,2) avg_score, COUNT(*)::int checks
       FROM qc_checks WHERE tenant_id=current_tenant_id() AND status IN ('completed','reviewed') AND completed_at >= date_trunc('month',NOW()) - INTERVAL '11 months'
       GROUP BY 1 ORDER BY 1`);
    const mystery = (await q(`SELECT ROUND(AVG(overall_score)::numeric,2) avg, COUNT(*)::int cnt FROM mystery_shopper_reports WHERE tenant_id=current_tenant_id() AND visit_date >= (NOW() - (${days} || ' days')::interval)::date`))[0];
    res.json({
      period_days: days,
      avg_score: main.avg_score ? Number(main.avg_score) : null,
      checks_count: main.checks_count,
      nc_count: nc.nc_count, by_severity: { critical: nc.critical, major: nc.major, minor: nc.minor }, nc_open: nc.open,
      top_fail_items: topFail, employee_ranking: ranking, trend,
      mystery_avg_score: mystery.avg ? Number(mystery.avg) : null, mystery_count: mystery.cnt,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/analytics/employee/:id(\\d+)', async (req, res) => {
  try {
    const main = (await q(
      `SELECT ROUND(AVG(total_score)::numeric,2) avg_score, COUNT(*)::int checks_count
       FROM qc_checks WHERE tenant_id=current_tenant_id() AND inspected_employee_id=$1 AND status IN ('completed','reviewed')`, [req.params.id]))[0];
    const ncCount = (await q(`SELECT COUNT(*)::int n FROM qc_non_conformities WHERE tenant_id=current_tenant_id() AND employee_id=$1`, [req.params.id]))[0].n;
    const last = await q(`SELECT id, scheduled_date, completed_at, total_score, result FROM qc_checks WHERE tenant_id=current_tenant_id() AND inspected_employee_id=$1 AND status IN ('completed','reviewed') ORDER BY completed_at DESC LIMIT 10`, [req.params.id]);
    res.json({ employee_id: Number(req.params.id), avg_score: main.avg_score ? Number(main.avg_score) : null, checks_count: main.checks_count, nc_count: ncCount, last_checks: last });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
