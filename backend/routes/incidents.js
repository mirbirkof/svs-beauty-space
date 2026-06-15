/* routes/incidents.js — MGT-04 Управління інцидентами (тікет-система нештатних ситуацій).
   Реєстр з SLA-індикатором, авто-номер INC-YYYY-NNNN, статуси, root cause analysis,
   корективні/превентивні дії, ескалація, коментарі, дашборд, аналітика. Може породити задачу MGT-01.
   Прагматика під один салон. Доступ: GET=incidents.read, мутації=incidents.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const TYPES = ['complaint', 'equipment', 'conflict', 'safety', 'sanitary', 'it', 'theft', 'other'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const STATUSES = ['open', 'investigating', 'pending_action', 'resolved', 'closed', 'reopened'];
const ROOT_CAUSES = ['human_error', 'process_gap', 'equipment_failure', 'supplier_issue', 'communication', 'training', 'other'];
// SLA у хвилинах: [перша реакція, рішення]
const SLA = { critical: [15, 120], high: [60, 480], medium: [240, 1440], low: [1440, 4320] };

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'incidents.read' : 'incidents.write';
  return requirePerm(perm)(req, res, next);
});

// Генерація номера INC-YYYY-NNNN (з ретраєм на унікальність)
async function nextNumber() {
  const year = new Date().getFullYear();
  const prefix = `INC-${year}-`;
  const row = (await q(
    `SELECT COALESCE(MAX(CAST(split_part(incident_number,'-',3) AS INTEGER)),0) mx
     FROM incidents WHERE tenant_id=current_tenant_id() AND incident_number LIKE $1`, [prefix + '%']))[0];
  return prefix + String((row.mx || 0) + 1).padStart(4, '0');
}

// SLA-індикатор: red(прострочено)|yellow(<1год до дедлайну)|green
function slaColor(inc) {
  if (['resolved', 'closed'].includes(inc.status)) return 'green';
  const dl = inc.sla_resolution_at ? new Date(inc.sla_resolution_at) : null;
  if (!dl) return 'green';
  const ms = dl - new Date();
  if (ms < 0) return 'red';
  if (ms < 3600e3) return 'yellow';
  return 'green';
}

// ── Реєстр ──
router.get('/', async (req, res) => {
  try {
    const w = ['tenant_id = current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.status) add('status = ?', req.query.status);
    if (req.query.priority) add('priority = ?', req.query.priority);
    if (req.query.incident_type) add('incident_type = ?', req.query.incident_type);
    if (req.query.category_id) add('category_id = ?', Number(req.query.category_id));
    if (req.query.assignee_id) add('assignee_id = ?', Number(req.query.assignee_id));
    if (req.query.client_id) add('client_id = ?', Number(req.query.client_id));
    if (req.query.mine === '1' && req.user?.id != null) add('assignee_id = ?', req.user.id);
    if (req.query.open === '1') w.push("status NOT IN ('closed','resolved')");
    if (req.query.overdue === '1') w.push("sla_resolution_at < NOW() AND status NOT IN ('resolved','closed')");
    if (req.query.q) { p.push('%' + req.query.q + '%'); w.push(`(title ILIKE $${p.length} OR incident_number ILIKE $${p.length} OR description ILIKE $${p.length})`); }
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const offset = Number(req.query.offset) || 0;
    p.push(limit); const li = p.length; p.push(offset); const oi = p.length;
    const rows = await q(
      `SELECT * FROM incidents WHERE ${w.join(' AND ')}
       ORDER BY (status IN ('resolved','closed')) ASC,
         array_position(ARRAY['critical','high','medium','low'], priority),
         (sla_resolution_at IS NULL), sla_resolution_at ASC, id DESC
       LIMIT $${li} OFFSET $${oi}`, p);
    for (const inc of rows) inc.sla_color = slaColor(inc);
    res.json({ ok: true, incidents: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Дашборд ──
router.get('/dashboard', async (req, res) => {
  try {
    const byStatus = await q(`SELECT status, COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() GROUP BY status`);
    const byPriority = await q(`SELECT priority, COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND status NOT IN ('resolved','closed') GROUP BY priority`);
    const open = (await q(`SELECT COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND status NOT IN ('resolved','closed')`))[0].n;
    const overdue = (await q(`SELECT COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND sla_resolution_at < NOW() AND status NOT IN ('resolved','closed')`))[0].n;
    const recent = await q(`SELECT id,incident_number,title,priority,status,incident_type,sla_resolution_at FROM incidents WHERE tenant_id=current_tenant_id() AND status NOT IN ('resolved','closed') ORDER BY array_position(ARRAY['critical','high','medium','low'],priority), sla_resolution_at ASC NULLS LAST LIMIT 10`);
    for (const r of recent) r.sla_color = slaColor(r);
    res.json({ ok: true, by_status: byStatus, by_priority: byPriority, open, overdue, recent });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Аналітика (проблемні зони, root cause) ──
router.get('/analytics', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const byType = await q(`SELECT incident_type, COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND created_at::date BETWEEN $1 AND $2 GROUP BY incident_type ORDER BY n DESC`, [from, to]);
    const byCategory = await q(`SELECT c.name, COUNT(*)::int n FROM incidents i LEFT JOIN incident_categories c ON c.id=i.category_id WHERE i.tenant_id=current_tenant_id() AND i.created_at::date BETWEEN $1 AND $2 GROUP BY c.name ORDER BY n DESC`, [from, to]);
    const byRootCause = await q(`SELECT root_cause_category, COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND root_cause_category IS NOT NULL AND created_at::date BETWEEN $1 AND $2 GROUP BY root_cause_category ORDER BY n DESC`, [from, to]);
    const slaPerf = (await q(
      `SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at <= sla_resolution_at)::int in_sla,
        COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL)::numeric,1),0) avg_resolve_hours
       FROM incidents WHERE tenant_id=current_tenant_id() AND created_at::date BETWEEN $1 AND $2`, [from, to]))[0];
    slaPerf.sla_compliance_pct = slaPerf.total ? Math.round(slaPerf.in_sla * 100 / slaPerf.total) : 0;
    const topClients = await q(`SELECT client_id, COUNT(*)::int n FROM incidents WHERE tenant_id=current_tenant_id() AND client_id IS NOT NULL AND incident_type='complaint' AND created_at::date BETWEEN $1 AND $2 GROUP BY client_id ORDER BY n DESC LIMIT 5`, [from, to]);
    res.json({ ok: true, period: { from, to }, by_type: byType, by_category: byCategory, by_root_cause: byRootCause, sla: slaPerf, top_complaint_clients: topClients });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Створення ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ ok: false, error: 'title required' });
    const type = TYPES.includes(b.incident_type) ? b.incident_type : 'other';
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const source = ['manual', 'review', 'callback', 'auto'].includes(b.source) ? b.source : 'manual';
    const [respMin, resolMin] = SLA[priority];
    let attempt = 0, ins;
    while (attempt++ < 5) {
      try {
        const num = await nextNumber();
        ins = await q(
          `INSERT INTO incidents (incident_number, title, description, incident_type, category_id, priority,
             status, source, source_ref_id, assignee_id, assignee_name, reporter_id, reporter_name,
             client_id, related_employee_id, appointment_id, service_id,
             sla_first_response_at, sla_resolution_at)
           VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             NOW() + ($17 || ' minutes')::interval, NOW() + ($18 || ' minutes')::interval) RETURNING *`,
          [num, b.title, b.description || '', type, b.category_id || null, priority,
           source, b.source_ref_id || null, b.assignee_id || null, b.assignee_name || null,
           req.user?.id ?? null, req.user?.display_name || null,
           b.client_id || null, b.related_employee_id || null, b.appointment_id || null, b.service_id || null,
           String(respMin), String(resolMin)]);
        break;
      } catch (e) {
        if (String(e.message).includes('ux_incidents_number') && attempt < 5) continue;
        throw e;
      }
    }
    logAction({ user: req.user, action: 'incident.create', entity: 'incident', entity_id: ins[0].id, ip: req.ip, meta: { number: ins[0].incident_number, type, priority } }).catch(() => {});
    res.json({ ok: true, incident: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Картка + коментарі ──
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const inc = (await q(`SELECT * FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
    inc.sla_color = slaColor(inc);
    const comments = await q(`SELECT * FROM incident_comments WHERE incident_id=$1 AND tenant_id=current_tenant_id() ORDER BY id ASC`, [req.params.id]);
    res.json({ ok: true, incident: inc, comments });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Оновлення (включно з root cause/дії/компенсація) ──
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (c, v) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.incident_type !== undefined && TYPES.includes(b.incident_type)) set('incident_type', b.incident_type);
    if (b.category_id !== undefined) set('category_id', b.category_id || null);
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) set('priority', b.priority);
    if (b.assignee_id !== undefined) { set('assignee_id', b.assignee_id || null); set('assignee_name', b.assignee_name || null); }
    if (b.related_employee_id !== undefined) set('related_employee_id', b.related_employee_id || null);
    if (b.client_id !== undefined) set('client_id', b.client_id || null);
    if (b.appointment_id !== undefined) set('appointment_id', b.appointment_id || null);
    if (b.service_id !== undefined) set('service_id', b.service_id || null);
    if (b.root_cause_category !== undefined && (b.root_cause_category === null || ROOT_CAUSES.includes(b.root_cause_category))) set('root_cause_category', b.root_cause_category || null);
    if (b.root_cause_description !== undefined) set('root_cause_description', b.root_cause_description || null);
    if (b.corrective_action !== undefined) set('corrective_action', b.corrective_action || null);
    if (b.preventive_action !== undefined) set('preventive_action', b.preventive_action || null);
    if (b.compensation !== undefined) set('compensation', b.compensation || null);
    if (b.client_satisfaction !== undefined && (b.client_satisfaction === null || ['satisfied', 'partial', 'unsatisfied'].includes(b.client_satisfaction))) set('client_satisfaction', b.client_satisfaction || null);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push('updated_at=NOW()'); p.push(req.params.id);
    const upd = await q(`UPDATE incidents SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    // якщо змінився пріоритет — перерахунок SLA-дедлайнів від created_at
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) {
      const [rm, sm] = SLA[b.priority];
      await q(`UPDATE incidents SET sla_first_response_at = created_at + ($1||' minutes')::interval, sla_resolution_at = created_at + ($2||' minutes')::interval WHERE id=$3 AND tenant_id=current_tenant_id()`, [String(rm), String(sm), req.params.id]);
    }
    const fresh = (await q(`SELECT * FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    logAction({ user: req.user, action: 'incident.update', entity: 'incident', entity_id: Number(req.params.id), ip: req.ip, meta: { fields: Object.keys(b) } }).catch(() => {});
    res.json({ ok: true, incident: fresh });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Зміна статусу (авто-таймстемпи + reopen ескалація) ──
router.patch('/:id(\\d+)/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'bad status' });
    const cur = (await q(`SELECT * FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
    const sets = ['status = $1', 'updated_at = NOW()']; const p = [status];
    // перша реакція — коли вперше пішли з open
    if (!cur.first_responded_at && status !== 'open') { p.push(new Date()); sets.push(`first_responded_at = $${p.length}`); }
    if (status === 'resolved') { sets.push('resolved_at = NOW()'); }
    if (status === 'closed') { sets.push('closed_at = NOW()'); if (!cur.resolved_at) sets.push('resolved_at = NOW()'); }
    if (status === 'reopened') { sets.push('resolved_at = NULL', 'closed_at = NULL', `escalation_level = ${Math.min(3, (cur.escalation_level || 0) + 1)}`); }
    p.push(req.params.id);
    const upd = await q(`UPDATE incidents SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    upd[0].sla_color = slaColor(upd[0]);
    logAction({ user: req.user, action: 'incident.status', entity: 'incident', entity_id: cur.id, ip: req.ip, meta: { status, from: cur.status } }).catch(() => {});
    res.json({ ok: true, incident: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Ескалація вручну ──
router.patch('/:id(\\d+)/escalate', async (req, res) => {
  try {
    const upd = await q(`UPDATE incidents SET escalation_level = LEAST(3, escalation_level+1), updated_at=NOW() WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id, escalation_level`, [req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, escalation_level: upd[0].escalation_level });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'incident.delete', entity: 'incident', entity_id: Number(req.params.id), ip: req.ip, meta: {} }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Породити задачу MGT-01 з інциденту (корективна дія) ──
router.post('/:id(\\d+)/spawn-task', async (req, res) => {
  try {
    const inc = (await q(`SELECT * FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
    const title = req.body?.title || `[${inc.incident_number}] ${inc.title}`;
    const pr = inc.priority === 'critical' ? 'critical' : inc.priority === 'high' ? 'high' : 'medium';
    const ins = await q(
      `INSERT INTO tasks (title, description, priority, status, assignee_id, assignee_name, client_id, tags)
       VALUES ($1,$2,$3,'todo',$4,$5,$6, ARRAY['incident']) RETURNING id, title`,
      [title, req.body?.description || inc.corrective_action || inc.description, pr, inc.assignee_id || null, inc.assignee_name || null, inc.client_id || null]);
    res.json({ ok: true, task: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Коментарі ──
router.get('/:id(\\d+)/comments', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM incident_comments WHERE incident_id=$1 AND tenant_id=current_tenant_id() ORDER BY id ASC`, [req.params.id]);
    res.json({ ok: true, comments: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/:id(\\d+)/comments', async (req, res) => {
  try {
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'body required' });
    const inc = (await q(`SELECT id, first_responded_at, status FROM incidents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
    const ins = await q(
      `INSERT INTO incident_comments (incident_id, author_id, author_name, body, is_internal)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user?.id ?? null, req.user?.display_name || null, body, req.body?.is_internal !== false]);
    // перший коментар фіксує першу реакцію
    if (!inc.first_responded_at) {
      await q(`UPDATE incidents SET first_responded_at=NOW(), status=CASE WHEN status='open' THEN 'investigating' ELSE status END, updated_at=NOW() WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    }
    res.json({ ok: true, comment: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Категорії ──
router.get('/categories/list', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM incident_categories WHERE tenant_id=current_tenant_id() ORDER BY sort_order, name`);
    res.json({ ok: true, categories: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/categories', async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ ok: false, error: 'name required' });
    const ins = await q(`INSERT INTO incident_categories (name, description, sort_order) VALUES ($1,$2,$3) RETURNING *`,
      [req.body.name, req.body.description || null, req.body.sort_order || 0]);
    res.json({ ok: true, category: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/categories/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM incident_categories WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
