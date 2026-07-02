/* routes/employees.js — CRM-09 Employees (реєстр персоналу).
   Будується ПОВЕРХ masters (джерело правди по майстрах). Звʼязка послуг живе в
   master_services (модуль 105) — тут не дублюється. Додає кадрові поля, довідники
   посад/відділів/спеціалізацій, документи та історію карʼєри.
   Доступ: GET = users.read; мутації = users.write (як керування майстрами).
   /public — без авторизації (публічний каталог майстрів). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const err = (res, e) => { console.error('[employees]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); };

// ── ПУБЛІЧНИЙ каталог майстрів (до auth-мідлвару) ──
router.get('/public', async (req, res) => {
  try {
    const params = [], wh = [`m.active = true`, `m.public_profile = true`, `COALESCE(m.status,'active') <> 'fired'`];
    if (req.query.specialization_id) {
      params.push(+req.query.specialization_id);
      wh.push(`EXISTS (SELECT 1 FROM employee_specializations es WHERE es.employee_id=m.id AND es.specialization_id=$${params.length})`);
    }
    if (req.query.branch_id) { params.push(+req.query.branch_id); wh.push(`m.branch_id=$${params.length}`); }
    const rows = await q(
      `SELECT m.id, m.name, m.avatar AS photo, m.bio, m.rating, m.specialty,
              m.social_instagram, m.social_tiktok,
              COALESCE(json_agg(DISTINCT sp.name) FILTER (WHERE sp.name IS NOT NULL), '[]') AS specializations
         FROM masters m
         LEFT JOIN employee_specializations es ON es.employee_id = m.id
         LEFT JOIN specializations sp ON sp.id = es.specialization_id AND sp.active = true
        WHERE ${wh.join(' AND ')}
        GROUP BY m.id
        ORDER BY m.sort_order, m.name`, params);
    res.json({ items: rows, count: rows.length });
  } catch (e) { err(res, e); }
});

// ── далі — авторизація ──
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'users.read' : 'users.write';
  return requirePerm(perm)(req, res, next);
});

// ── ДОВІДНИКИ: відділи ──
router.get('/departments', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM departments WHERE active=true ORDER BY name`) }); } catch (e) { err(res, e); }
});
router.post('/departments', async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    const r = await q(`INSERT INTO departments (name, parent_id) VALUES ($1,$2) RETURNING *`, [req.body.name, req.body.parent_id || null]);
    res.json({ ok: true, department: r[0] });
  } catch (e) { err(res, e); }
});

// ── ДОВІДНИКИ: посади ──
router.get('/positions', async (req, res) => {
  try {
    res.json({ items: await q(
      `SELECT p.*, d.name AS department_name FROM positions p
         LEFT JOIN departments d ON d.id=p.department_id
        WHERE p.active=true ORDER BY p.level DESC, p.name`) });
  } catch (e) { err(res, e); }
});
router.post('/positions', async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    const r = await q(`INSERT INTO positions (name, department_id, level) VALUES ($1,$2,$3) RETURNING *`,
      [req.body.name, req.body.department_id || null, req.body.level || 0]);
    res.json({ ok: true, position: r[0] });
  } catch (e) { err(res, e); }
});

// ── ДОВІДНИКИ: спеціалізації ──
router.get('/specializations', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM specializations WHERE active=true ORDER BY name`) }); } catch (e) { err(res, e); }
});
router.post('/specializations', async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    const r = await q(`INSERT INTO specializations (name, description, icon) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, icon=EXCLUDED.icon, updated_at=NOW() RETURNING *`,
      [req.body.name, req.body.description || null, req.body.icon || null]);
    res.json({ ok: true, specialization: r[0] });
  } catch (e) { err(res, e); }
});

// ── РЕЄСТР співробітників ──
router.get('/', async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.status) { params.push(req.query.status); wh.push(`COALESCE(m.status,'active')=$${params.length}`); }
    if (req.query.position_id) { params.push(+req.query.position_id); wh.push(`m.position_id=$${params.length}`); }
    if (req.query.branch_id) { params.push(+req.query.branch_id); wh.push(`m.branch_id=$${params.length}`); }
    if (req.query.specialization_id) {
      params.push(+req.query.specialization_id);
      wh.push(`EXISTS (SELECT 1 FROM employee_specializations es WHERE es.employee_id=m.id AND es.specialization_id=$${params.length})`);
    }
    if (req.query.search) { params.push('%' + req.query.search + '%'); wh.push(`(m.name ILIKE $${params.length} OR m.phone ILIKE $${params.length})`); }
    const limit = Math.min(+req.query.limit || 50, 200);
    const offset = +req.query.offset || 0;
    const where = wh.length ? 'WHERE ' + wh.join(' AND ') : '';
    const items = await q(
      `SELECT m.id, m.name, m.phone, m.email, m.avatar, m.specialty, m.mastery_level,
              COALESCE(m.status,'active') AS status, m.rating, m.hire_date, m.active,
              m.position_id, p.name AS position_name, m.department_id, d.name AS department_name
         FROM masters m
         LEFT JOIN positions p ON p.id=m.position_id
         LEFT JOIN departments d ON d.id=m.department_id
        ${where}
        ORDER BY m.sort_order, m.name
        LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await q(`SELECT COUNT(*)::int AS c FROM masters m ${where}`, params))[0].c;
    res.json({ items, total });
  } catch (e) { err(res, e); }
});

// ── КАРТКА співробітника (повна) ──
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = +req.params.id;
    const emp = (await q(
      `SELECT m.*, p.name AS position_name, d.name AS department_name, mgr.name AS manager_name
         FROM masters m
         LEFT JOIN positions p ON p.id=m.position_id
         LEFT JOIN departments d ON d.id=m.department_id
         LEFT JOIN masters mgr ON mgr.id=m.manager_id
        WHERE m.id=$1`, [id]))[0];
    if (!emp) return res.status(404).json({ error: 'not found' });
    const [specializations, services, documents, history] = await Promise.all([
      q(`SELECT es.*, sp.name AS specialization_name, sp.icon FROM employee_specializations es
           JOIN specializations sp ON sp.id=es.specialization_id WHERE es.employee_id=$1 ORDER BY sp.name`, [id]),
      q(`SELECT ms.id, ms.service_id, ms.price, ms.duration_min, ms.active, s.name AS service_name
           FROM master_services ms JOIN services s ON s.id=ms.service_id WHERE ms.master_id=$1 ORDER BY s.name`, [id]).catch(() => []),
      q(`SELECT * FROM employee_documents WHERE employee_id=$1 ORDER BY expires_at NULLS LAST`, [id]),
      q(`SELECT * FROM employee_history WHERE employee_id=$1 ORDER BY event_date DESC, id DESC`, [id]),
    ]);
    const stats = (await q(
      `SELECT COUNT(*) FILTER (WHERE status='done')::int AS done_visits,
              COUNT(DISTINCT client_id) FILTER (WHERE status='done')::int AS unique_clients
         FROM appointments WHERE master_id=$1`, [id]).catch(() => [{}]))[0] || {};
    res.json({ employee: emp, specializations, services, documents, history, stats });
  } catch (e) { err(res, e); }
});

// ── СТВОРИТИ співробітника ──
const { validateBody, t } = require('../lib/validate');
const DATE_RE = /^\d{4}-\d{2}-\d{2}/; // YYYY-MM-DD (допускаем и полный ISO)
const employeeSchema = (required) => ({
  name:  t.string({ min: 1, max: 200, required }),
  phone: t.phone({ required }),
  email: t.email({ required: false }),
  birth_date: t.string({ required: false, pattern: DATE_RE, max: 30 }),
  hire_date:  t.string({ required: false, pattern: DATE_RE, max: 30 }),
  position_id: t.id({ required: false }),
  department_id: t.id({ required: false }),
  manager_id: t.id({ required: false }),
  branch_id: t.id({ required: false }),
});

router.post('/', validateBody(employeeSchema(true)), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.phone) return res.status(400).json({ error: 'name, phone required' });
    const r = await q(
      `INSERT INTO masters (name, phone, email, specialty, avatar, birth_date, gender, hire_date,
                            position_id, department_id, manager_id, branch_id, mastery_level, status,
                            public_profile, bio, social_instagram, social_tiktok, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true) RETURNING *`,
      [b.name, b.phone, b.email || null, b.specialty || null, b.avatar || null, b.birth_date || null,
       b.gender || null, b.hire_date || null, b.position_id || null, b.department_id || null,
       b.manager_id || null, b.branch_id || null, b.mastery_level || 'junior', b.status || 'active',
       b.public_profile !== false, b.bio || null, b.social_instagram || null, b.social_tiktok || null]);
    await q(`INSERT INTO employee_history (employee_id, event_type, initiated_by, event_date)
             VALUES ($1,'hired',$2,COALESCE($3,CURRENT_DATE))`, [r[0].id, req.user?.display_name || null, b.hire_date || null]).catch(()=>{});
    logAction({ user: req.user, action: 'employee.create', entity: 'master', entity_id: r[0].id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, employee: r[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'phone already exists' });
    err(res, e);
  }
});

// ── РЕДАГУВАТИ ──
router.patch('/:id(\\d+)', validateBody(employeeSchema(false)), async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'email', 'specialty', 'avatar', 'birth_date', 'gender', 'hire_date',
      'fire_date', 'position_id', 'department_id', 'manager_id', 'branch_id', 'mastery_level', 'status',
      'public_profile', 'bio', 'social_instagram', 'social_tiktok', 'sort_order', 'commission_pct', 'active'];
    // phone входить у unique (tenant_id, phone): порожній рядок → NULL, інакше два
    // співробітники без телефону падають у 23505 і профіль не зберігається.
    const nullIfEmpty = new Set(['phone', 'email', 'specialty', 'avatar', 'birth_date', 'hire_date', 'fire_date',
      'position_id', 'department_id', 'manager_id', 'branch_id', 'bio', 'social_instagram', 'social_tiktok']);
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) {
      let v = req.body[k];
      if (nullIfEmpty.has(k) && typeof v === 'string' && v.trim() === '') v = null;
      vals.push(v); sets.push(`${k}=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(+req.params.id);
    const r = await q(`UPDATE masters SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'employee.update', entity: 'master', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, employee: r[0] });
  } catch (e) { err(res, e); }
});

// ── ЗВІЛЬНИТИ (soft) ──
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const r = await q(`UPDATE masters SET status='fired', fire_date=CURRENT_DATE, active=false, updated_at=NOW()
       WHERE id=$1 RETURNING id`, [+req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    await q(`INSERT INTO employee_history (employee_id, event_type, details, initiated_by)
             VALUES ($1,'fired',$2,$3)`, [+req.params.id, JSON.stringify({ reason: req.body?.reason || null }), req.user?.display_name || null]).catch(()=>{});
    logAction({ user: req.user, action: 'employee.fire', entity: 'master', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

// ── СПЕЦІАЛІЗАЦІЇ співробітника ──
router.get('/:id(\\d+)/specializations', async (req, res) => {
  try {
    res.json({ items: await q(
      `SELECT es.*, sp.name AS specialization_name FROM employee_specializations es
         JOIN specializations sp ON sp.id=es.specialization_id WHERE es.employee_id=$1 ORDER BY sp.name`, [+req.params.id]) });
  } catch (e) { err(res, e); }
});
router.post('/:id(\\d+)/specializations', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.specialization_id) return res.status(400).json({ error: 'specialization_id required' });
    const r = await q(
      `INSERT INTO employee_specializations (employee_id, specialization_id, level, certified_at, next_certification)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (employee_id, specialization_id) DO UPDATE
         SET level=EXCLUDED.level, certified_at=EXCLUDED.certified_at, next_certification=EXCLUDED.next_certification
       RETURNING *`,
      [+req.params.id, +b.specialization_id, b.level || 'middle', b.certified_at || null, b.next_certification || null]);
    res.json({ ok: true, specialization: r[0] });
  } catch (e) { err(res, e); }
});
router.delete('/:id(\\d+)/specializations/:specId(\\d+)', async (req, res) => {
  try {
    await q(`DELETE FROM employee_specializations WHERE employee_id=$1 AND specialization_id=$2`, [+req.params.id, +req.params.specId]);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

// ── ДОКУМЕНТИ співробітника ──
router.get('/:id(\\d+)/documents', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM employee_documents WHERE employee_id=$1 ORDER BY expires_at NULLS LAST`, [+req.params.id]) }); } catch (e) { err(res, e); }
});
router.post('/:id(\\d+)/documents', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.doc_type || !b.title) return res.status(400).json({ error: 'doc_type, title required' });
    // статус за датою закінчення: <0 = expired, <30 днів = expiring
    const r = await q(
      `INSERT INTO employee_documents (employee_id, doc_type, title, file_url, issued_at, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,
         CASE WHEN $6::date IS NULL THEN 'active'
              WHEN $6::date < CURRENT_DATE THEN 'expired'
              WHEN $6::date < CURRENT_DATE + INTERVAL '30 days' THEN 'expiring'
              ELSE 'active' END) RETURNING *`,
      [+req.params.id, b.doc_type, b.title, b.file_url || null, b.issued_at || null, b.expires_at || null]);
    res.json({ ok: true, document: r[0] });
  } catch (e) { err(res, e); }
});
router.delete('/:id(\\d+)/documents/:docId(\\d+)', async (req, res) => {
  try {
    await q(`DELETE FROM employee_documents WHERE employee_id=$1 AND id=$2`, [+req.params.id, +req.params.docId]);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

// ── ІСТОРІЯ / карʼєрний трек ──
router.get('/:id(\\d+)/history', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM employee_history WHERE employee_id=$1 ORDER BY event_date DESC, id DESC`, [+req.params.id]) }); } catch (e) { err(res, e); }
});
router.post('/:id(\\d+)/history', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.event_type) return res.status(400).json({ error: 'event_type required' });
    const r = await q(
      `INSERT INTO employee_history (employee_id, event_type, details, initiated_by, event_date)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE)) RETURNING *`,
      [+req.params.id, b.event_type, JSON.stringify(b.details || {}), req.user?.display_name || null, b.event_date || null]);
    // якщо рівень/посада змінились — підтягнути в masters
    if (b.details?.to_position) await q(`UPDATE masters SET position_id=$1, updated_at=NOW() WHERE id=$2`, [b.details.to_position, +req.params.id]).catch(()=>{});
    if (b.details?.to_level) await q(`UPDATE masters SET mastery_level=$1, updated_at=NOW() WHERE id=$2`, [b.details.to_level, +req.params.id]).catch(()=>{});
    res.json({ ok: true, event: r[0] });
  } catch (e) { err(res, e); }
});

module.exports = router;
