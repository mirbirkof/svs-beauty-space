/* routes/onboarding.js — Адаптація / навчання / атестація співробітників.
   GET  /api/onboarding/:masterId        — чек-лист майстра
   GET  /api/onboarding/summary          — зведення по всіх (для керуючого)
   POST /api/onboarding/:masterId         — додати пункт {category,title,due_date}
   POST /api/onboarding/:masterId/seed    — створити стандартний чек-лист новачка
   PATCH /api/onboarding/item/:id         — {status} відмітити виконаним/назад
   DELETE /api/onboarding/item/:id        — видалити пункт
   Доступ: GET staff.read, мутації staff.manage (fallback reports.finance). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// Стандартний шаблон адаптації новачка
const TEMPLATE = [
  { category: 'adaptation', title: 'Підписати договір' },
  { category: 'adaptation', title: 'Ознайомити з правилами салону і дрес-кодом' },
  { category: 'adaptation', title: 'Видати доступи (CRM, графік, чати)' },
  { category: 'adaptation', title: 'Екскурсія по салону, знайомство з командою' },
  { category: 'training', title: 'Навчання по сервісу (зустріч клієнта, скрипти)' },
  { category: 'training', title: 'Навчання по продукту (лінійки, ціни, допродажі)' },
  { category: 'attestation', title: 'Атестація після випробувального терміну' },
];

router.get('/summary', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.name,
              COUNT(o.*)::int total,
              COUNT(o.*) FILTER (WHERE o.status='done')::int done,
              COUNT(o.*) FILTER (WHERE o.status='pending' AND o.due_date IS NOT NULL AND o.due_date < CURRENT_DATE)::int overdue
         FROM masters m JOIN staff_onboarding o ON o.master_id=m.id
        WHERE COALESCE(m.active,true)=true
        GROUP BY m.id, m.name
        ORDER BY overdue DESC, (COUNT(o.*) FILTER (WHERE o.status='done')::float / NULLIF(COUNT(o.*),0)) ASC`);
    res.json({ items: r.rows.map(x => ({ master_id: x.id, name: x.name, total: x.total, done: x.done, overdue: x.overdue,
      pct: x.total > 0 ? Math.round(x.done / x.total * 100) : 0 })) });
  } catch (e) { console.error('[onboarding/summary]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/:masterId(\\d+)', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, category, title, status, due_date, done_at, done_by, notes
         FROM staff_onboarding WHERE master_id=$1 ORDER BY
         CASE category WHEN 'adaptation' THEN 1 WHEN 'training' THEN 2 ELSE 3 END, id`, [req.params.masterId]);
    res.json({ master_id: Number(req.params.masterId), items: r.rows });
  } catch (e) { console.error('[onboarding/list]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

const canWrite = requirePerm('reports.finance');

router.post('/:masterId(\\d+)/seed', canWrite, async (req, res) => {
  try {
    const mid = Number(req.params.masterId);
    const ex = await pool.query(`SELECT COUNT(*)::int n FROM staff_onboarding WHERE master_id=$1`, [mid]);
    if (ex.rows[0].n > 0) return res.json({ ok: true, skipped: true, message: 'чек-лист вже існує' });
    for (const t of TEMPLATE) {
      await pool.query(`INSERT INTO staff_onboarding (master_id, category, title) VALUES ($1,$2,$3)`, [mid, t.category, t.title]);
    }
    res.json({ ok: true, created: TEMPLATE.length });
  } catch (e) { console.error('[onboarding/seed]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/:masterId(\\d+)', canWrite, async (req, res) => {
  try {
    const { category, title, due_date } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await pool.query(
      `INSERT INTO staff_onboarding (master_id, category, title, due_date)
       VALUES ($1,$2,$3,$4::date) RETURNING id`,
      [Number(req.params.masterId), category || 'adaptation', title, due_date || null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error('[onboarding/add]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.patch('/item/:id(\\d+)', canWrite, async (req, res) => {
  try {
    const done = req.body && req.body.status === 'done';
    const r = await pool.query(
      `UPDATE staff_onboarding
          SET status=$2, done_at=CASE WHEN $2='done' THEN NOW() ELSE NULL END,
              done_by=CASE WHEN $2='done' THEN $3 ELSE NULL END
        WHERE id=$1 RETURNING id, status`,
      [req.params.id, done ? 'done' : 'pending', (req.user && req.user.display_name) || null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { console.error('[onboarding/patch]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.delete('/item/:id(\\d+)', canWrite, async (req, res) => {
  try {
    await pool.query(`DELETE FROM staff_onboarding WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[onboarding/del]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
