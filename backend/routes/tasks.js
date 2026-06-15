/* routes/tasks.js — MGT-01 Задачі/доручення команди салону.
   Kanban-дошка (backlog→todo→in_progress→review→done), фільтри, чек-листи,
   коментарі, шаблони, повторювані задачі. Прагматично під один салон:
   теги→TEXT[], чек-лист→JSONB, вкладення через окремий files.js.
   Доступ: GET = tasks.read, мутації = tasks.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'tasks.read' : 'tasks.write';
  return requirePerm(perm)(req, res, next);
});

// Нормалізація чек-листа: [{text,done}]
function normChecklist(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => x && typeof x.text === 'string')
    .map(x => ({ text: String(x.text).slice(0, 500), done: !!x.done }));
}
function normTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
function nextRecurrence(rec, base) {
  if (!rec) return null;
  const d = base ? new Date(base) : new Date();
  if (rec === 'daily') d.setDate(d.getDate() + 1);
  else if (rec === 'weekly') d.setDate(d.getDate() + 7);
  else if (rec === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

// ── Список з фільтрами ──
// ?status=&priority=&assignee_id=&tag=&q=&mine=1&overdue=1&limit=&offset=
router.get('/', async (req, res) => {
  try {
    const w = ['tenant_id = current_tenant_id()'];
    const p = [];
    const add = (cond, val) => { p.push(val); w.push(cond.replace('?', '$' + p.length)); };
    if (req.query.status) add('status = ?', req.query.status);
    if (req.query.priority) add('priority = ?', req.query.priority);
    if (req.query.assignee_id) add('assignee_id = ?', Number(req.query.assignee_id));
    if (req.query.mine === '1' && req.user?.id) add('assignee_id = ?', req.user.id);
    if (req.query.tag) add('tags @> ARRAY[?]::text[]', String(req.query.tag).toLowerCase());
    if (req.query.overdue === '1') w.push("due_date < CURRENT_DATE AND status NOT IN ('done','cancelled')");
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const offset = Number(req.query.offset) || 0;
    // q-фільтр обробляємо окремо щоб уникнути плутанини з плейсхолдерами
    let where = w.join(' AND ');
    if (req.query.q) {
      p.push('%' + req.query.q + '%');
      where += ` AND (title ILIKE $${p.length} OR description ILIKE $${p.length})`;
    }
    p.push(limit); const li = p.length;
    p.push(offset); const oi = p.length;
    const rows = await q(
      `SELECT * FROM tasks WHERE ${where}
       ORDER BY (status IN ('done','cancelled')) ASC,
         array_position(ARRAY['critical','high','medium','low'], priority),
         (due_date IS NULL), due_date ASC, sort_order ASC, id DESC
       LIMIT $${li} OFFSET $${oi}`, p);
    res.json({ ok: true, tasks: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Kanban-дошка: групування по статусу ──
router.get('/board', async (req, res) => {
  try {
    const p = [];
    let extra = '';
    if (req.query.assignee_id) { p.push(Number(req.query.assignee_id)); extra += ` AND assignee_id = $${p.length}`; }
    if (req.query.mine === '1' && req.user?.id) { p.push(req.user.id); extra += ` AND assignee_id = $${p.length}`; }
    const rows = await q(
      `SELECT * FROM tasks WHERE tenant_id = current_tenant_id() AND status <> 'cancelled' ${extra}
       ORDER BY array_position(ARRAY['critical','high','medium','low'], priority),
         (due_date IS NULL), due_date ASC, sort_order ASC, id DESC`, p);
    const board = {};
    for (const s of STATUSES) if (s !== 'cancelled') board[s] = [];
    for (const t of rows) (board[t.status] = board[t.status] || []).push(t);
    res.json({ ok: true, board });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Статистика ──
router.get('/stats', async (req, res) => {
  try {
    const byStatus = await q(
      `SELECT status, COUNT(*)::int n FROM tasks WHERE tenant_id = current_tenant_id() GROUP BY status`);
    const byPriority = await q(
      `SELECT priority, COUNT(*)::int n FROM tasks WHERE tenant_id = current_tenant_id()
       AND status NOT IN ('done','cancelled') GROUP BY priority`);
    const overdue = (await q(
      `SELECT COUNT(*)::int n FROM tasks WHERE tenant_id = current_tenant_id()
       AND due_date < CURRENT_DATE AND status NOT IN ('done','cancelled')`))[0].n;
    const dueToday = (await q(
      `SELECT COUNT(*)::int n FROM tasks WHERE tenant_id = current_tenant_id()
       AND due_date = CURRENT_DATE AND status NOT IN ('done','cancelled')`))[0].n;
    const avgDone = (await q(
      `SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600)::numeric,1),0) h
       FROM tasks WHERE tenant_id = current_tenant_id() AND status='done' AND completed_at IS NOT NULL`))[0].h;
    const byAssignee = await q(
      `SELECT assignee_id, assignee_name, COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status NOT IN ('done','cancelled'))::int open
       FROM tasks WHERE tenant_id = current_tenant_id() AND assignee_id IS NOT NULL
       GROUP BY assignee_id, assignee_name ORDER BY open DESC`);
    res.json({ ok: true, by_status: byStatus, by_priority: byPriority, overdue, due_today: dueToday, avg_done_hours: Number(avgDone), by_assignee: byAssignee });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Створення (опційно з шаблону) ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    let base = { title: b.title, description: b.description, priority: b.priority, checklist: b.checklist, tags: b.tags };
    if (b.template_id) {
      const tpl = (await q(`SELECT * FROM task_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [b.template_id]))[0];
      if (tpl) base = {
        title: b.title || tpl.title,
        description: b.description || tpl.description,
        priority: b.priority || tpl.priority,
        checklist: b.checklist || tpl.checklist,
        tags: b.tags || tpl.tags
      };
    }
    if (!base.title) return res.status(400).json({ ok: false, error: 'title required' });
    const priority = PRIORITIES.includes(base.priority) ? base.priority : 'medium';
    const status = STATUSES.includes(b.status) ? b.status : 'todo';
    const rec = ['daily', 'weekly', 'monthly'].includes(b.recurrence) ? b.recurrence : null;
    const ins = await q(
      `INSERT INTO tasks (title, description, priority, status, assignee_id, assignee_name,
         creator_id, creator_name, due_date, estimated_minutes, client_id, appointment_id,
         service_id, tags, checklist, recurrence, recurrence_next, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [base.title, base.description || null, priority, status,
       b.assignee_id || null, b.assignee_name || null,
       req.user?.id || null, req.user?.display_name || null,
       b.due_date || null, b.estimated_minutes || null,
       b.client_id || null, b.appointment_id || null, b.service_id || null,
       normTags(base.tags), JSON.stringify(normChecklist(base.checklist)),
       rec, rec ? nextRecurrence(rec, b.due_date) : null, b.sort_order || 0]);
    logAction({ user: req.user, action: 'task.create', entity: 'task', entity_id: ins[0].id, ip: req.ip, meta: { title: base.title, priority } }).catch(() => {});
    res.json({ ok: true, task: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Одна задача + коментарі ──
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const t = (await q(`SELECT * FROM tasks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    const comments = await q(`SELECT * FROM task_comments WHERE task_id=$1 AND tenant_id=current_tenant_id() ORDER BY id ASC`, [req.params.id]);
    res.json({ ok: true, task: t, comments });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Оновлення полів ──
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (col, val) => { p.push(val); sets.push(`${col} = $${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) set('priority', b.priority);
    if (b.assignee_id !== undefined) { set('assignee_id', b.assignee_id || null); set('assignee_name', b.assignee_name || null); }
    if (b.due_date !== undefined) set('due_date', b.due_date || null);
    if (b.estimated_minutes !== undefined) set('estimated_minutes', b.estimated_minutes || null);
    if (b.actual_minutes !== undefined) set('actual_minutes', b.actual_minutes || null);
    if (b.client_id !== undefined) set('client_id', b.client_id || null);
    if (b.appointment_id !== undefined) set('appointment_id', b.appointment_id || null);
    if (b.service_id !== undefined) set('service_id', b.service_id || null);
    if (b.tags !== undefined) set('tags', normTags(b.tags));
    if (b.checklist !== undefined) set('checklist', JSON.stringify(normChecklist(b.checklist)));
    if (b.sort_order !== undefined) set('sort_order', b.sort_order);
    if (b.recurrence !== undefined) {
      const rec = ['daily', 'weekly', 'monthly'].includes(b.recurrence) ? b.recurrence : null;
      set('recurrence', rec);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push('updated_at = NOW()');
    p.push(req.params.id);
    const upd = await q(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'task.update', entity: 'task', entity_id: Number(req.params.id), ip: req.ip, meta: { fields: Object.keys(b) } }).catch(() => {});
    res.json({ ok: true, task: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Зміна статусу (move на дошці) + spawn рекурентної ──
router.patch('/:id(\\d+)/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'bad status' });
    const done = status === 'done';
    const upd = await q(
      `UPDATE tasks SET status=$1, completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
         sort_order = COALESCE($3, sort_order), updated_at=NOW()
       WHERE id=$4 AND tenant_id=current_tenant_id() RETURNING *`,
      [status, done, req.body?.sort_order ?? null, req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    const t = upd[0];
    let spawned = null;
    // Якщо завершили повторювану — створюємо наступний інстанс
    if (done && t.recurrence) {
      const nd = nextRecurrence(t.recurrence, t.due_date || new Date());
      const sp = await q(
        `INSERT INTO tasks (title, description, priority, status, assignee_id, assignee_name,
           creator_id, creator_name, due_date, estimated_minutes, tags, checklist,
           recurrence, recurrence_next, sort_order)
         VALUES ($1,$2,$3,'todo',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, due_date`,
        [t.title, t.description, t.priority, t.assignee_id, t.assignee_name,
         t.creator_id, t.creator_name, nd, t.estimated_minutes, t.tags,
         JSON.stringify((t.checklist || []).map(c => ({ text: c.text, done: false }))),
         t.recurrence, nextRecurrence(t.recurrence, nd), t.sort_order]);
      spawned = sp[0];
    }
    logAction({ user: req.user, action: 'task.status', entity: 'task', entity_id: t.id, ip: req.ip, meta: { status, spawned: spawned?.id || null } }).catch(() => {});
    res.json({ ok: true, task: t, spawned });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Чек-лист: toggle/replace ──
router.patch('/:id(\\d+)/checklist', async (req, res) => {
  try {
    const cl = normChecklist(req.body?.checklist);
    const upd = await q(`UPDATE tasks SET checklist=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`,
      [JSON.stringify(cl), req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, task: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Видалення ──
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM tasks WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'task.delete', entity: 'task', entity_id: Number(req.params.id), ip: req.ip, meta: {} }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Коментарі ──
router.get('/:id(\\d+)/comments', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM task_comments WHERE task_id=$1 AND tenant_id=current_tenant_id() ORDER BY id ASC`, [req.params.id]);
    res.json({ ok: true, comments: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/:id(\\d+)/comments', async (req, res) => {
  try {
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'body required' });
    const t = (await q(`SELECT id FROM tasks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!t) return res.status(404).json({ ok: false, error: 'task not found' });
    const ins = await q(
      `INSERT INTO task_comments (task_id, author_id, author_name, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user?.id || null, req.user?.display_name || null, body]);
    res.json({ ok: true, comment: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Шаблони ──
router.get('/templates/list', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM task_templates WHERE tenant_id=current_tenant_id() ORDER BY name ASC`);
    res.json({ ok: true, templates: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.title) return res.status(400).json({ ok: false, error: 'name and title required' });
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const ins = await q(
      `INSERT INTO task_templates (name, title, description, priority, checklist, tags)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.name, b.title, b.description || null, priority,
       JSON.stringify(normChecklist(b.checklist)), normTags(b.tags)]);
    res.json({ ok: true, template: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/templates/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM task_templates WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Обробка рекурентних: підняти прострочені recurrence_next (cron tick) ──
router.post('/process-recurrence', async (req, res) => {
  try {
    // Знаходимо завершені повторювані без активного наступника на сьогодні/майбутнє
    const due = await q(
      `SELECT t.* FROM tasks t WHERE t.tenant_id=current_tenant_id()
        AND t.recurrence IS NOT NULL AND t.status IN ('done','cancelled')
        AND t.recurrence_next IS NOT NULL AND t.recurrence_next <= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM tasks n WHERE n.tenant_id=t.tenant_id AND n.title=t.title
            AND n.status NOT IN ('done','cancelled') AND n.recurrence=t.recurrence)`);
    let created = 0;
    for (const t of due) {
      const nd = t.recurrence_next;
      await q(
        `INSERT INTO tasks (title, description, priority, status, assignee_id, assignee_name,
           creator_id, creator_name, due_date, estimated_minutes, tags, checklist,
           recurrence, recurrence_next, sort_order)
         VALUES ($1,$2,$3,'todo',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [t.title, t.description, t.priority, t.assignee_id, t.assignee_name,
         t.creator_id, t.creator_name, nd, t.estimated_minutes, t.tags,
         JSON.stringify((t.checklist || []).map(c => ({ text: c.text, done: false }))),
         t.recurrence, nextRecurrence(t.recurrence, nd), t.sort_order]);
      // прибираємо recurrence_next з оригіналу щоб не дублювати
      await q(`UPDATE tasks SET recurrence_next=NULL WHERE id=$1`, [t.id]);
      created++;
    }
    res.json({ ok: true, created });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
