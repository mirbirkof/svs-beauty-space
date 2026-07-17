/* routes/dental.js — вертикаль СТОМАТОЛОГИЯ (18.07.2026, приказ Босса).
   Монтируется под requireVertical('dental') → для beauty/fitness модуля не существует (404).
   Таблицы dental_* (миграция 274), RLS per-tenant.
   Анамнез/согласия = существующий модуль /api/medical (medical_cards, procedure_consents).
   Приём = обычный appointment; кресло = rooms. Позиционирование: административная CRM
   клиники, не сертифицированная мед.система.

   Состав: одонтограмма (upsert + append-only история) · планы лечения (этапы ↔ визиты,
   смета) · зуботехлаборатория (статус-цепочка, расход в кассу идемпотентно) · снимки к зубам. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { requireFeature } = require('../lib/feature-gate');
const { recordCashOut } = require('../lib/cash-ledger');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'booking.read' : 'booking.write';
  return requirePerm(perm)(req, res, next);
});

const err500 = (res, e) => { console.error('[dental]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };
const TOOTH_OK = (n) => Number.isInteger(n) && n >= 11 && n <= 85 && n % 10 >= 1 && n % 10 <= 8;
const T_STATUSES = ['healthy', 'caries', 'filling', 'crown', 'implant', 'pulpitis', 'extracted', 'root', 'bridge', 'missing'];

/* ── Одонтограмма ─────────────────────────────────────────────────────────── */
router.get('/chart/:client_id', requireFeature('dental.chart'), async (req, res) => {
  try {
    const teeth = (await pool.query(`SELECT tooth_no, status, note, updated_at FROM dental_teeth WHERE client_id=$1`, [+req.params.client_id])).rows;
    res.json({ ok: true, teeth }); // отсутствующие зубы = healthy (строки не плодим)
  } catch (e) { err500(res, e); }
});

// Обновление зуба (или батч после приёма) — транзакция: upsert + история
router.post('/chart/:client_id/teeth', requireFeature('dental.chart'), async (req, res) => {
  const db = await pool.connect();
  try {
    const clientId = +req.params.client_id;
    const items = Array.isArray(req.body?.teeth) ? req.body.teeth : [req.body || {}];
    if (!items.length) return res.status(400).json({ error: 'teeth-required' });
    for (const t of items) {
      if (!TOOTH_OK(+t.tooth_no)) return res.status(400).json({ error: 'bad-tooth-no', tooth: t.tooth_no });
      if (!T_STATUSES.includes(t.status)) return res.status(400).json({ error: 'bad-status', allowed: T_STATUSES });
    }
    await db.query('BEGIN');
    const results = [];
    for (const t of items) {
      const old = (await db.query(`SELECT status FROM dental_teeth WHERE client_id=$1 AND tooth_no=$2`, [clientId, +t.tooth_no])).rows[0];
      const r = await db.query(
        `INSERT INTO dental_teeth (client_id, tooth_no, status, note, updated_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (client_id, tooth_no)
         DO UPDATE SET status=$3, note=COALESCE($4, dental_teeth.note), updated_at=NOW(), updated_by=$5
         RETURNING tooth_no, status`, [clientId, +t.tooth_no, t.status, t.note || null, req.user?.display_name || null]);
      await db.query(
        `INSERT INTO dental_tooth_history (client_id, tooth_no, old_status, new_status, note, appointment_id, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [clientId, +t.tooth_no, old?.status || 'healthy', t.status, t.note || null, req.body?.appointment_id || null, req.user?.display_name || null]);
      results.push(r.rows[0]);
    }
    await db.query('COMMIT');
    logAction({ user: req.user, action: 'dental.tooth.update', entity: 'dental_teeth', ip: req.ip, meta: { client_id: clientId, count: results.length } }).catch(() => {});
    res.json({ ok: true, updated: results });
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); err500(res, e); }
  finally { db.release(); }
});

router.get('/chart/:client_id/history', requireFeature('dental.chart'), async (req, res) => {
  try {
    const params = [+req.params.client_id]; let where = 'client_id=$1';
    if (req.query.tooth_no) { params.push(+req.query.tooth_no); where += ' AND tooth_no=$2'; }
    const r = await pool.query(`SELECT * FROM dental_tooth_history WHERE ${where} ORDER BY changed_at DESC LIMIT 100`, params);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

/* ── Планы лечения ────────────────────────────────────────────────────────── */
router.get('/plans', requireFeature('dental.plans'), async (req, res) => {
  try {
    const params = []; let where = '1=1';
    if (req.query.client_id) { params.push(+req.query.client_id); where += ` AND p.client_id=$${params.length}`; }
    if (req.query.status) { params.push(req.query.status); where += ` AND p.status=$${params.length}`; }
    const r = await pool.query(
      `SELECT p.*, c.name AS client_name,
              (SELECT COUNT(*) FROM dental_plan_stages s WHERE s.plan_id=p.id)::int AS stages_total,
              (SELECT COUNT(*) FROM dental_plan_stages s WHERE s.plan_id=p.id AND s.status='done')::int AS stages_done
         FROM dental_plans p JOIN clients c ON c.id=p.client_id
        WHERE ${where} ORDER BY p.created_at DESC LIMIT 200`, params);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.get('/plans/:id', requireFeature('dental.plans'), async (req, res) => {
  try {
    const p = (await pool.query(`SELECT p.*, c.name AS client_name FROM dental_plans p JOIN clients c ON c.id=p.client_id WHERE p.id=$1`, [+req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'not-found' });
    const stages = (await pool.query(
      `SELECT s.*, a.starts_at AS appt_starts_at, a.status AS appt_status
         FROM dental_plan_stages s LEFT JOIN appointments a ON a.id=s.appointment_id
        WHERE s.plan_id=$1 ORDER BY s.position, s.id`, [p.id])).rows;
    res.json({ ok: true, item: p, stages });
  } catch (e) { err500(res, e); }
});

router.post('/plans', requireFeature('dental.plans'), async (req, res) => {
  const db = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.client_id || !b.title) return res.status(400).json({ error: 'client_id and title required' });
    await db.query('BEGIN');
    const stages = Array.isArray(b.stages) ? b.stages : [];
    const total = stages.reduce((s, x) => s + (Number(x.estimate) || 0), 0) || b.total_estimate || null;
    const p = (await db.query(
      `INSERT INTO dental_plans (client_id, title, diagnosis, total_estimate, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [+b.client_id, String(b.title).trim(), b.diagnosis || null, total, req.user?.display_name || null])).rows[0];
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      await db.query(
        `INSERT INTO dental_plan_stages (plan_id, position, title, description, teeth, estimate)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, i, String(s.title || `Етап ${i + 1}`), s.description || null,
         (s.teeth || []).filter((n) => TOOTH_OK(+n)).map(Number), s.estimate || null]);
    }
    await db.query('COMMIT');
    logAction({ user: req.user, action: 'dental.plan.create', entity: 'dental_plans', entity_id: p.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, item: p });
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); err500(res, e); }
  finally { db.release(); }
});

router.patch('/plans/:id', requireFeature('dental.plans'), async (req, res) => {
  try {
    const b = req.body || {}; const id = +req.params.id;
    // Защита данных: план с выполненными этапами нельзя «удалить» — только cancelled
    if (b.status === 'cancelled') {
      const done = (await pool.query(`SELECT COUNT(*)::int AS c FROM dental_plan_stages WHERE plan_id=$1 AND status='done'`, [id])).rows[0];
      if (done.c > 0 && !b.force) return res.status(409).json({ error: 'has-done-stages', message: 'У плані є виконані етапи. Скасування збереже їх історію.', can_force: true });
    }
    const sets = []; const vals = []; let i = 1;
    for (const f of ['title', 'diagnosis', 'status', 'total_estimate']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (b.status === 'approved') sets.push(`approved_at=NOW()`);
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    vals.push(id);
    const r = await pool.query(`UPDATE dental_plans SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.post('/plans/:id/stages', requireFeature('dental.plans'), async (req, res) => {
  try {
    const b = req.body || {};
    const pos = (await pool.query(`SELECT COALESCE(MAX(position),-1)+1 AS p FROM dental_plan_stages WHERE plan_id=$1`, [+req.params.id])).rows[0].p;
    const r = await pool.query(
      `INSERT INTO dental_plan_stages (plan_id, position, title, description, teeth, estimate)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [+req.params.id, pos, String(b.title || 'Етап'), b.description || null,
       (b.teeth || []).filter((n) => TOOTH_OK(+n)).map(Number), b.estimate || null]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.patch('/stages/:id', requireFeature('dental.plans'), async (req, res) => {
  try {
    const b = req.body || {}; const sets = []; const vals = []; let i = 1;
    for (const f of ['title', 'description', 'teeth', 'estimate', 'status', 'appointment_id', 'position']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (b.status === 'done') sets.push(`done_at=NOW()`);
    if (b.appointment_id && b.status === undefined) { sets.push(`status='scheduled'`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    vals.push(+req.params.id);
    const r = await pool.query(`UPDATE dental_plan_stages SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    // все этапы done → план done (авто, мягко)
    if (b.status === 'done') {
      await pool.query(
        `UPDATE dental_plans SET status='done', updated_at=NOW()
          WHERE id=$1 AND status IN ('approved','in_progress')
            AND NOT EXISTS (SELECT 1 FROM dental_plan_stages WHERE plan_id=$1 AND status IN ('pending','scheduled'))`,
        [r.rows[0].plan_id]);
    }
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

/* ── Зуботехническая лаборатория ──────────────────────────────────────────── */
const LAB_FLOW = { draft: ['sent'], sent: ['ready', 'redo'], ready: ['fitted', 'redo'], fitted: ['closed'], redo: ['sent'], closed: [] };

router.get('/lab', requireFeature('dental.lab'), async (req, res) => {
  try {
    const params = []; let where = '1=1';
    if (req.query.status) { params.push(req.query.status); where += ` AND o.status=$${params.length}`; }
    else where += ` AND o.status <> 'closed'`;
    if (req.query.client_id) { params.push(+req.query.client_id); where += ` AND o.client_id=$${params.length}`; }
    const r = await pool.query(
      `SELECT o.*, c.name AS client_name,
              (o.due_date IS NOT NULL AND o.due_date < CURRENT_DATE AND o.status IN ('sent','redo')) AS overdue
         FROM dental_lab_orders o JOIN clients c ON c.id=o.client_id
        WHERE ${where} ORDER BY o.due_date NULLS LAST, o.created_at DESC LIMIT 200`, params);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.post('/lab', requireFeature('dental.lab'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.lab_name || !b.work_type) return res.status(400).json({ error: 'client_id, lab_name, work_type required' });
    const r = await pool.query(
      `INSERT INTO dental_lab_orders (client_id, appointment_id, lab_name, work_type, teeth, due_date, cost, price, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [+b.client_id, b.appointment_id || null, String(b.lab_name).trim(), String(b.work_type).trim(),
       (b.teeth || []).filter((n) => TOOTH_OK(+n)).map(Number), b.due_date || null, b.cost || null, b.price || null, b.note || null]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.patch('/lab/:id', requireFeature('dental.lab'), async (req, res) => {
  try {
    const b = req.body || {}; const id = +req.params.id;
    const cur = (await pool.query(`SELECT * FROM dental_lab_orders WHERE id=$1`, [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not-found' });
    if (b.status && b.status !== cur.status) {
      if (!(LAB_FLOW[cur.status] || []).includes(b.status)) {
        return res.status(409).json({ error: 'bad-transition', from: cur.status, allowed: LAB_FLOW[cur.status] });
      }
      const extra = b.status === 'sent' ? `, sent_at=NOW()` : b.status === 'ready' ? `, ready_at=NOW()` : '';
      await pool.query(`UPDATE dental_lab_orders SET status=$1${extra}, updated_at=NOW() WHERE id=$2`, [b.status, id]);
      // Расход в кассу при первой отправке (идемпотентно через cash_operation_id)
      if (b.status === 'sent' && Number(cur.cost) > 0 && !cur.cash_operation_id) {
        try {
          const opId = await recordCashOut({ category: 'lab_expense', amount: Number(cur.cost), method: 'transfer',
            ref_type: 'dental_lab', ref_id: id, description: `Лабораторія ${cur.lab_name}: ${cur.work_type}`, ext_ref: `dental-lab-${id}` });
          if (opId) await pool.query(`UPDATE dental_lab_orders SET cash_operation_id=$1 WHERE id=$2`, [opId, id]);
        } catch (ce) { console.error('[dental/lab] cash out:', ce.message); }
      }
    }
    const sets = []; const vals = []; let i = 1;
    for (const f of ['lab_name', 'work_type', 'teeth', 'due_date', 'cost', 'price', 'note']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (sets.length) { vals.push(id); await pool.query(`UPDATE dental_lab_orders SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i}`, vals); }
    const r = (await pool.query(`SELECT * FROM dental_lab_orders WHERE id=$1`, [id])).rows[0];
    logAction({ user: req.user, action: 'dental.lab.update', entity: 'dental_lab_orders', entity_id: id, ip: req.ip, meta: { status: r.status } }).catch(() => {});
    res.json({ ok: true, item: r });
  } catch (e) { err500(res, e); }
});

/* ── Снимки к зубам ───────────────────────────────────────────────────────── */
router.get('/files/:client_id', requireFeature('dental.chart'), async (req, res) => {
  try {
    const params = [+req.params.client_id]; let where = 'client_id=$1';
    if (req.query.tooth_no) { params.push(+req.query.tooth_no); where += ' AND tooth_no=$2'; }
    const r = await pool.query(`SELECT * FROM dental_tooth_files WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.post('/files', requireFeature('dental.chart'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || (!b.file_id && !b.url)) return res.status(400).json({ error: 'client_id and file_id|url required' });
    if (b.tooth_no !== undefined && b.tooth_no !== null && !TOOTH_OK(+b.tooth_no)) return res.status(400).json({ error: 'bad-tooth-no' });
    const r = await pool.query(
      `INSERT INTO dental_tooth_files (client_id, tooth_no, file_id, url, kind, appointment_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [+b.client_id, b.tooth_no ?? null, b.file_id || null, b.url || null,
       ['xray', 'photo', 'doc'].includes(b.kind) ? b.kind : 'xray', b.appointment_id || null, b.note || null]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

module.exports = router;
