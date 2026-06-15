/* routes/projects.js — MGT-02 Проекти/ініціативи.
   Ієрархія проект → фаза → веха → задача (MGT-01). Реєстр, картка, авто-прогрес із задач,
   бюджет план/факт + health-індикатор, шаблони (автоген структури), дані для Gantt, дашборд.
   Прагматика під один салон: без branch_id, Gantt рахується на льоту. Доступ: GET=projects.read, мутації=projects.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const STATUSES = ['draft', 'planning', 'active', 'on_hold', 'completed', 'cancelled'];
const TYPES = ['renovation', 'new_branch', 'training', 'marketing', 'crm_implementation', 'certification', 'other'];
const PRIORITIES = ['high', 'medium', 'low'];

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'projects.read' : 'projects.write';
  return requirePerm(perm)(req, res, next);
});

function normTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
function addDays(base, days) {
  const d = base ? new Date(base) : new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

// Авто-прогрес проекту = % виконаних задач. Повертає {total,done,pct}
async function taskProgress(projectId) {
  const r = (await q(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='done')::int done
     FROM tasks WHERE tenant_id=current_tenant_id() AND project_id=$1`, [projectId]))[0];
  const pct = r.total ? Math.round(r.done * 100 / r.total) : 0;
  return { total: r.total, done: r.done, pct };
}

// Health-індикатор: green|yellow|red за відхиленням бюджету + дедлайном
function health(p) {
  const bp = Number(p.budget_planned) || 0, ba = Number(p.budget_actual) || 0;
  const overBudget = bp > 0 ? (ba - bp) / bp : 0;
  const overdue = p.planned_end && new Date(p.planned_end) < new Date() && !['completed', 'cancelled'].includes(p.status);
  if (overBudget > 0.1 || overdue) return 'red';
  if (overBudget > 0 || (bp > 0 && ba / bp > 0.9)) return 'yellow';
  return 'green';
}

// ── Реєстр ──
router.get('/', async (req, res) => {
  try {
    const w = ['tenant_id = current_tenant_id()']; const p = [];
    const add = (cond, val) => { p.push(val); w.push(cond.replace('?', '$' + p.length)); };
    if (req.query.status) add('status = ?', req.query.status);
    if (req.query.project_type) add('project_type = ?', req.query.project_type);
    if (req.query.owner_id) add('owner_id = ?', Number(req.query.owner_id));
    if (req.query.archived === '1') w.push("status IN ('completed','cancelled')");
    else if (req.query.archived === '0') w.push("status NOT IN ('completed','cancelled')");
    if (req.query.q) { p.push('%' + req.query.q + '%'); w.push(`title ILIKE $${p.length}`); }
    const rows = await q(
      `SELECT * FROM projects WHERE ${w.join(' AND ')}
       ORDER BY array_position(ARRAY['high','medium','low'], priority),
         (planned_end IS NULL), planned_end ASC, id DESC`, p);
    for (const pr of rows) pr.health = health(pr);
    res.json({ ok: true, projects: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Дашборд портфеля ──
router.get('/dashboard', async (req, res) => {
  try {
    const byStatus = await q(`SELECT status, COUNT(*)::int n FROM projects WHERE tenant_id=current_tenant_id() GROUP BY status`);
    const active = await q(
      `SELECT * FROM projects WHERE tenant_id=current_tenant_id() AND status IN ('planning','active','on_hold')
       ORDER BY array_position(ARRAY['high','medium','low'], priority), planned_end ASC NULLS LAST`);
    for (const pr of active) {
      if (pr.progress_mode === 'auto') pr.progress = (await taskProgress(pr.id)).pct;
      pr.health = health(pr);
    }
    const budget = (await q(
      `SELECT COALESCE(SUM(budget_planned),0)::numeric planned, COALESCE(SUM(budget_actual),0)::numeric actual
       FROM projects WHERE tenant_id=current_tenant_id() AND status NOT IN ('cancelled')`))[0];
    res.json({ ok: true, by_status: byStatus, active, budget_total: budget });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Аналітика ──
router.get('/analytics', async (req, res) => {
  try {
    const byStatus = await q(`SELECT status, COUNT(*)::int n FROM projects WHERE tenant_id=current_tenant_id() GROUP BY status`);
    const byType = await q(`SELECT project_type, COUNT(*)::int n FROM projects WHERE tenant_id=current_tenant_id() GROUP BY project_type`);
    const avgDur = (await q(
      `SELECT COALESCE(ROUND(AVG(actual_end - actual_start)),0)::int days FROM projects
       WHERE tenant_id=current_tenant_id() AND status='completed' AND actual_start IS NOT NULL AND actual_end IS NOT NULL`))[0].days;
    const budgetDev = await q(
      `SELECT id, title, budget_planned, budget_actual,
        CASE WHEN budget_planned>0 THEN ROUND((budget_actual-budget_planned)*100/budget_planned,1) ELSE 0 END pct_dev
       FROM projects WHERE tenant_id=current_tenant_id() AND status IN ('active','completed') AND budget_planned>0
       ORDER BY pct_dev DESC NULLS LAST LIMIT 10`);
    res.json({ ok: true, by_status: byStatus, by_type: byType, avg_duration_days: avgDur, budget_deviations: budgetDev });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Створення (опційно з шаблону → генерує фази/вехи/задачі) ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    let tpl = null;
    if (b.template_id) tpl = (await q(`SELECT * FROM project_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [b.template_id]))[0] || null;
    const title = b.title || tpl?.name;
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });
    const type = TYPES.includes(b.project_type || tpl?.project_type) ? (b.project_type || tpl.project_type) : 'other';
    const status = STATUSES.includes(b.status) ? b.status : 'draft';
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const struct = tpl?.structure || {};
    const budgetPlanned = b.budget_planned ?? struct.budget_planned ?? 0;
    const ins = await q(
      `INSERT INTO projects (template_id, title, description, project_type, status, priority,
         owner_id, owner_name, planned_start, planned_end, budget_planned, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.template_id || null, title, b.description || tpl?.description || null, type, status, priority,
       b.owner_id || req.user?.id || null, b.owner_name || req.user?.display_name || null,
       b.planned_start || null, b.planned_end || null, budgetPlanned, normTags(b.tags)]);
    const proj = ins[0];
    // Розгортання структури шаблону
    if (tpl && Array.isArray(struct.phases)) {
      const startBase = b.planned_start || new Date().toISOString().slice(0, 10);
      let order = 0;
      for (const ph of struct.phases) {
        const phStart = ph.offset_days != null ? addDays(startBase, ph.offset_days) : null;
        const phEnd = (ph.offset_days != null && ph.duration_days != null) ? addDays(startBase, ph.offset_days + ph.duration_days) : null;
        const phIns = await q(
          `INSERT INTO project_phases (project_id, name, description, sort_order, planned_start, planned_end)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [proj.id, ph.name || ('Фаза ' + (order + 1)), ph.description || null, order++, phStart, phEnd]);
        const phaseId = phIns[0].id;
        for (const ms of (ph.milestones || [])) {
          await q(`INSERT INTO project_milestones (project_id, phase_id, title, due_date) VALUES ($1,$2,$3,$4)`,
            [proj.id, phaseId, ms.title || 'Веха', ms.offset_days != null ? addDays(startBase, ms.offset_days) : null]);
        }
        for (const tk of (ph.tasks || [])) {
          await q(`INSERT INTO tasks (title, priority, status, project_id, phase_id) VALUES ($1,$2,'todo',$3,$4)`,
            [tk.title || 'Задача', PRIORITIES.includes(tk.priority) ? tk.priority : 'medium', proj.id, phaseId]);
        }
      }
    }
    logAction({ user: req.user, action: 'project.create', entity: 'project', entity_id: proj.id, ip: req.ip, meta: { title, from_template: b.template_id || null } }).catch(() => {});
    res.json({ ok: true, project: proj });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Картка проекту (фази, вехи, задачі, бюджет-відхилення) ──
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const proj = (await q(`SELECT * FROM projects WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!proj) return res.status(404).json({ ok: false, error: 'not found' });
    const phases = await q(`SELECT * FROM project_phases WHERE project_id=$1 AND tenant_id=current_tenant_id() ORDER BY sort_order, id`, [req.params.id]);
    const milestones = await q(`SELECT * FROM project_milestones WHERE project_id=$1 AND tenant_id=current_tenant_id() ORDER BY due_date NULLS LAST, id`, [req.params.id]);
    const tasks = await q(`SELECT id, title, status, priority, phase_id, due_date, assignee_name FROM tasks WHERE project_id=$1 AND tenant_id=current_tenant_id() ORDER BY phase_id NULLS LAST, id`, [req.params.id]);
    const prog = await taskProgress(req.params.id);
    if (proj.progress_mode === 'auto') proj.progress = prog.pct;
    // прогрес кожної фази = % done задач у фазі
    for (const ph of phases) {
      const pt = tasks.filter(t => String(t.phase_id) === String(ph.id));
      ph.task_total = pt.length;
      ph.task_done = pt.filter(t => t.status === 'done').length;
      ph.progress = pt.length ? Math.round(ph.task_done * 100 / pt.length) : 0;
    }
    // підсвітка прострочених вех
    const today = new Date().toISOString().slice(0, 10);
    for (const ms of milestones) if (ms.status === 'pending' && ms.due_date && ms.due_date.toISOString().slice(0, 10) < today) ms.overdue = true;
    const bp = Number(proj.budget_planned) || 0, ba = Number(proj.budget_actual) || 0;
    const budget = { planned: bp, actual: ba, deviation: ba - bp, deviation_pct: bp > 0 ? Math.round((ba - bp) * 1000 / bp) / 10 : 0 };
    proj.health = health(proj);
    res.json({ ok: true, project: proj, phases, milestones, tasks, task_progress: prog, budget });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Дані для Gantt ──
router.get('/:id(\\d+)/gantt', async (req, res) => {
  try {
    const phases = await q(`SELECT id, name, sort_order, planned_start, planned_end, status FROM project_phases WHERE project_id=$1 AND tenant_id=current_tenant_id() ORDER BY sort_order, id`, [req.params.id]);
    const milestones = await q(`SELECT id, phase_id, title, due_date, status FROM project_milestones WHERE project_id=$1 AND tenant_id=current_tenant_id() ORDER BY due_date NULLS LAST`, [req.params.id]);
    res.json({ ok: true, today: new Date().toISOString().slice(0, 10), phases, milestones });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Оновлення проекту ──
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (col, val) => { p.push(val); sets.push(`${col} = $${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.project_type !== undefined && TYPES.includes(b.project_type)) set('project_type', b.project_type);
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) set('priority', b.priority);
    if (b.owner_id !== undefined) { set('owner_id', b.owner_id || null); set('owner_name', b.owner_name || null); }
    if (b.planned_start !== undefined) set('planned_start', b.planned_start || null);
    if (b.planned_end !== undefined) set('planned_end', b.planned_end || null);
    if (b.actual_start !== undefined) set('actual_start', b.actual_start || null);
    if (b.actual_end !== undefined) set('actual_end', b.actual_end || null);
    if (b.budget_planned !== undefined) set('budget_planned', b.budget_planned || 0);
    if (b.budget_actual !== undefined) set('budget_actual', b.budget_actual || 0);
    if (b.progress_mode !== undefined && ['auto', 'manual'].includes(b.progress_mode)) set('progress_mode', b.progress_mode);
    if (b.progress !== undefined) set('progress', Math.max(0, Math.min(100, Number(b.progress) || 0)));
    if (b.tags !== undefined) set('tags', normTags(b.tags));
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push('updated_at = NOW()'); p.push(req.params.id);
    const upd = await q(`UPDATE projects SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'project.update', entity: 'project', entity_id: Number(req.params.id), ip: req.ip, meta: { fields: Object.keys(b) } }).catch(() => {});
    res.json({ ok: true, project: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Зміна статусу (auto actual_start/end) ──
router.patch('/:id(\\d+)/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'bad status' });
    const upd = await q(
      `UPDATE projects SET status=$1,
         actual_start = CASE WHEN $1 IN ('active') AND actual_start IS NULL THEN CURRENT_DATE ELSE actual_start END,
         actual_end   = CASE WHEN $1='completed' THEN CURRENT_DATE WHEN $1 IN ('active','planning','on_hold') THEN NULL ELSE actual_end END,
         updated_at=NOW()
       WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`, [status, req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'project.status', entity: 'project', entity_id: Number(req.params.id), ip: req.ip, meta: { status } }).catch(() => {});
    res.json({ ok: true, project: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM projects WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    // відвʼязуємо задачі (не видаляємо — це операційка)
    await q(`UPDATE tasks SET project_id=NULL, phase_id=NULL WHERE project_id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    logAction({ user: req.user, action: 'project.delete', entity: 'project', entity_id: Number(req.params.id), ip: req.ip, meta: {} }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Фази ──
router.post('/:id(\\d+)/phases', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ ok: false, error: 'name required' });
    const proj = (await q(`SELECT id FROM projects WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!proj) return res.status(404).json({ ok: false, error: 'project not found' });
    const ord = b.sort_order ?? (await q(`SELECT COALESCE(MAX(sort_order)+1,0) n FROM project_phases WHERE project_id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0].n;
    const ins = await q(
      `INSERT INTO project_phases (project_id, name, description, sort_order, planned_start, planned_end, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, b.name, b.description || null, ord, b.planned_start || null, b.planned_end || null, ['pending', 'active', 'done'].includes(b.status) ? b.status : 'pending']);
    res.json({ ok: true, phase: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/phases/:pid(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (c, v) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.name !== undefined) set('name', b.name);
    if (b.description !== undefined) set('description', b.description);
    if (b.sort_order !== undefined) set('sort_order', b.sort_order);
    if (b.planned_start !== undefined) set('planned_start', b.planned_start || null);
    if (b.planned_end !== undefined) set('planned_end', b.planned_end || null);
    if (b.status !== undefined && ['pending', 'active', 'done'].includes(b.status)) set('status', b.status);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    p.push(req.params.pid);
    const upd = await q(`UPDATE project_phases SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, phase: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/phases/:pid(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM project_phases WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.pid]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    await q(`UPDATE tasks SET phase_id=NULL WHERE phase_id=$1 AND tenant_id=current_tenant_id()`, [req.params.pid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Вехи ──
router.post('/:id(\\d+)/milestones', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ ok: false, error: 'title required' });
    const proj = (await q(`SELECT id FROM projects WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!proj) return res.status(404).json({ ok: false, error: 'project not found' });
    const ins = await q(
      `INSERT INTO project_milestones (project_id, phase_id, title, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, b.phase_id || null, b.title, b.due_date || null]);
    res.json({ ok: true, milestone: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.patch('/milestones/:mid(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (c, v) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.due_date !== undefined) set('due_date', b.due_date || null);
    if (b.phase_id !== undefined) set('phase_id', b.phase_id || null);
    if (b.status !== undefined && ['pending', 'achieved', 'missed'].includes(b.status)) {
      set('status', b.status);
      set('achieved_at', b.status === 'achieved' ? new Date() : null);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    p.push(req.params.mid);
    const upd = await q(`UPDATE project_milestones SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, milestone: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/milestones/:mid(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM project_milestones WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.mid]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Шаблони ──
router.get('/templates/list', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM project_templates WHERE tenant_id=current_tenant_id() ORDER BY name`);
    res.json({ ok: true, templates: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ ok: false, error: 'name required' });
    const type = TYPES.includes(b.project_type) ? b.project_type : 'other';
    const ins = await q(
      `INSERT INTO project_templates (name, project_type, description, structure) VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.name, type, b.description || null, JSON.stringify(b.structure || {})]);
    res.json({ ok: true, template: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/templates/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM project_templates WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
