/* ═══════════════════════════════════════════════════════
   MGT-08 — Конструктор форм (Forms Builder)
   Подключается как /api/forms

   Что закрывает:
   - CRUD форм с полями-схемой (JSONB): анкеты, согласия, заявки, опросы;
   - сбор ответов (form_submissions) + просмотр/экспорт;
   - публичные формы по slug БЕЗ авторизации (для лендингов/QR);
   - валидация обязательных полей на сабмите;
   - привязка ответа к клиенту (client_id) если передан.

   Права: forms.read / forms.write (миграция 088).
   Публичные эндпоинты (/public/*) — без авторизации, только status=published & is_public.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// нормализация массива полей формы
function normFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((f, i) => ({
    key: String(f.key || `field_${i + 1}`),
    label: String(f.label || f.key || `Поле ${i + 1}`),
    type: ['text', 'textarea', 'number', 'email', 'phone', 'date', 'select', 'checkbox', 'radio', 'rating'].includes(f.type) ? f.type : 'text',
    required: !!f.required,
    options: Array.isArray(f.options) ? f.options.map(String) : undefined,
    placeholder: f.placeholder ? String(f.placeholder) : undefined,
  }));
}

// валидация ответа против схемы → массив ошибок
function validate(fields, data) {
  const errors = [];
  for (const f of fields) {
    const v = data[f.key];
    if (f.required && (v === undefined || v === null || String(v).trim() === '')) {
      errors.push({ key: f.key, error: 'required' });
    }
  }
  return errors;
}

/* ── ПУБЛИЧНЫЕ ЭНДПОИНТЫ (без авторизации) ──
   Объявлены ДО requirePerm-middleware, поэтому проверка прав на них не действует. */

// GET /api/forms/public/:slug — получить опубликованную публичную форму
router.get('/public/:slug', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, title, description, fields, success_message
       FROM forms WHERE slug=$1 AND status='published' AND is_public=true LIMIT 1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/forms/public/:slug/submit — отправить ответ на публичную форму
router.post('/public/:slug/submit', async (req, res) => {
  try {
    const f = (await q(
      `SELECT id, fields, success_message FROM forms
       WHERE slug=$1 AND status='published' AND is_public=true LIMIT 1`,
      [req.params.slug]
    ))[0];
    if (!f) return res.status(404).json({ error: 'not_found' });

    const fields = Array.isArray(f.fields) ? f.fields : [];
    const data = req.body?.data || {};
    const errors = validate(fields, data);
    if (errors.length) return res.status(422).json({ error: 'validation_failed', errors });

    const sub = (await q(
      `INSERT INTO form_submissions (form_id, client_id, data, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [f.id, req.body?.client_id || null, JSON.stringify(data),
       req.ip || null, req.get('user-agent') || null]
    ))[0];
    await pool.query(`UPDATE forms SET submit_count = submit_count + 1 WHERE id=$1`, [f.id]);
    res.json({ ok: true, id: sub.id, message: f.success_message || 'Дякуємо!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── АВТОРИЗОВАННЫЕ ЭНДПОИНТЫ ── */
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'forms.read' : 'forms.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/forms — список форм
router.get('/', async (req, res) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = 'tenant_id = current_tenant_id()';
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const rows = await q(
      `SELECT id, title, slug, status, is_public, submit_count, created_at, updated_at,
              jsonb_array_length(fields) AS field_count
       FROM forms WHERE ${where} ORDER BY updated_at DESC`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/forms/:id — детали формы
router.get('/:id', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM forms WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/forms/:id/submissions — ответы на форму
router.get('/:id/submissions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await q(
      `SELECT s.id, s.client_id, s.data, s.created_at, c.name AS client_name, c.phone AS client_phone
       FROM form_submissions s
       LEFT JOIN clients c ON c.id = s.client_id
       WHERE s.form_id=$1 AND s.tenant_id=current_tenant_id()
       ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`, [req.params.id]);
    const total = (await q(`SELECT count(*)::int n FROM form_submissions WHERE form_id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0].n;
    res.json({ rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/forms — создать форму
router.post('/', async (req, res) => {
  try {
    const { title, slug, description, fields, status, is_public, success_message } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const row = (await q(
      `INSERT INTO forms (title, slug, description, fields, status, is_public, success_message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, slug || null, description || null, JSON.stringify(normFields(fields)),
       status || 'draft', !!is_public, success_message || null, req.user?.id || null]
    ))[0];
    await logAction({ user: req.user, action: 'form.create', entity: 'forms', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/forms/:id — обновить форму
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'slug', 'description', 'fields', 'status', 'is_public', 'success_message'];
    const sets = [], params = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        params.push(k === 'fields' ? JSON.stringify(normFields(req.body[k])) : req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(
      `UPDATE forms SET ${sets.join(', ')}, updated_at=now()
       WHERE id=$${params.length} AND tenant_id=current_tenant_id() RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'form.update', entity: 'forms', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/forms/:id/submit — ответ от авторизованного (админка, ресепшн)
router.post('/:id/submit', async (req, res) => {
  try {
    const f = (await q(`SELECT id, fields FROM forms WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!f) return res.status(404).json({ error: 'not_found' });
    const data = req.body?.data || {};
    const errors = validate(Array.isArray(f.fields) ? f.fields : [], data);
    if (errors.length) return res.status(422).json({ error: 'validation_failed', errors });
    const sub = (await q(
      `INSERT INTO form_submissions (form_id, client_id, data, ip) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [f.id, req.body?.client_id || null, JSON.stringify(data), req.ip || null]))[0];
    await pool.query(`UPDATE forms SET submit_count = submit_count + 1 WHERE id=$1`, [f.id]);
    res.json({ ok: true, id: sub.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/forms/:id — удалить форму (с ответами, CASCADE)
router.delete('/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'form.delete', entity: 'forms', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
