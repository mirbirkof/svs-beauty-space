/* routes/documents.js — MGT-06 Документообіг.
   Реєстр документів, версіонування, lock/unlock, контроль строків (expiring),
   повнотекстовий пошук (FTS), коментарі, відправка на підпис (-> MGT-07),
   шаблони з полями + генерація документа підстановкою {{field_key}}.
   Фізичні файли — у таблиці files (M28), тут лише метадані + file_storage_id.
   Прагматика під один салон. Доступ: GET=documents.read, мутації=documents.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { emit } = require('../lib/event-bus');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const one = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] || null);

const CATEGORIES = ['contract', 'act', 'invoice', 'order', 'regulation', 'certificate', 'other'];
const TPL_CATEGORIES = ['contract', 'consent', 'act', 'invoice', 'other'];
const EXPIRY_THRESHOLDS = [30, 14, 7, 1];
const ENTITY_TABLES = { client: 'clients', employee: 'masters', supplier: 'suppliers' };

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'documents.read' : 'documents.write';
  return requirePerm(perm)(req, res, next);
});

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const jstr = (v, def) => { try { return v == null ? def : (typeof v === 'string' ? JSON.parse(v) : v); } catch { return def; } };

// ═══════════════════ ДОКУМЕНТИ ═══════════════════

// Реєстр з фільтрами
router.get('/', async (req, res) => {
  try {
    const w = ['tenant_id = current_tenant_id()', 'deleted_at IS NULL']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.category) add('category = ?', req.query.category);
    if (req.query.status) add('status = ?', req.query.status);
    if (req.query.client_id) add('client_id = ?', num(req.query.client_id));
    if (req.query.employee_id) add('employee_id = ?', num(req.query.employee_id));
    if (req.query.supplier_id) add('supplier_id = ?', num(req.query.supplier_id));
    if (req.query.visit_id) add('visit_id = ?', num(req.query.visit_id));
    if (req.query.esign_status) add('esign_status = ?', req.query.esign_status);
    if (req.query.tag) { p.push(JSON.stringify([req.query.tag])); w.push(`tags @> $${p.length}::jsonb`); }
    if (req.query.from) add('created_at >= ?', req.query.from);
    if (req.query.to) add('created_at <= ?', req.query.to);
    if (req.query.q) { p.push('%' + req.query.q + '%'); w.push(`(title ILIKE $${p.length} OR description ILIKE $${p.length} OR file_name ILIKE $${p.length})`); }
    const limit = Math.min(num(req.query.limit) || 50, 200);
    const offset = num(req.query.offset) || 0;
    const items = await q(
      `SELECT id, category, title, description, file_storage_id, file_name, file_size, mime_type,
              current_version, client_id, employee_id, supplier_id, visit_id, tags, expires_at,
              status, esign_status, locked_by, locked_at, is_template_generated, created_by, created_at, updated_at
         FROM documents WHERE ${w.join(' AND ')}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, p);
    const total = (await one(`SELECT COUNT(*)::int n FROM documents WHERE ${w.join(' AND ')}`, p)).n;
    res.json({ items, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Дашборд строків, що спливають (ДО /:id)
router.get('/expiring', async (req, res) => {
  try {
    const days = num(req.query.days) || 30;
    const rows = await q(
      `SELECT id, category, title, file_name, client_id, employee_id, supplier_id, expires_at,
              (expires_at - CURRENT_DATE) AS days_left, status
         FROM documents
        WHERE tenant_id=current_tenant_id() AND deleted_at IS NULL AND expires_at IS NOT NULL
          AND expires_at <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY expires_at ASC`, [days]);
    const buckets = { expired: [], in7: [], in30: [] };
    for (const r of rows) {
      if (r.days_left < 0) buckets.expired.push(r);
      else if (r.days_left <= 7) buckets.in7.push(r);
      else buckets.in30.push(r);
    }
    res.json({
      items: rows,
      summary: { expired: buckets.expired.length, in7: buckets.in7.length, in30: buckets.in30.length },
      buckets,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Повнотекстовий пошук (ДО /:id)
router.get('/search', async (req, res) => {
  const t0 = Date.now();
  try {
    const term = (req.query.q || '').trim();
    if (!term) return res.json({ items: [], total: 0, took_ms: 0 });
    const tsq = term.split(/\s+/).filter(Boolean).map(x => x.replace(/[^\wа-яіїєґ]/gi, '') + ':*').filter(x => x.length > 1).join(' & ');
    if (!tsq) return res.json({ items: [], total: 0, took_ms: 0 });
    const w = ['tenant_id=current_tenant_id()', 'deleted_at IS NULL', `full_text_index @@ to_tsquery('simple', $1)`];
    const p = [tsq];
    if (req.query.category) { p.push(req.query.category); w.push(`category=$${p.length}`); }
    const items = await q(
      `SELECT id, category, title, file_name, client_id, employee_id, expires_at, status, created_at,
              ts_rank(full_text_index, to_tsquery('simple', $1)) AS rank,
              ts_headline('simple', COALESCE(description, title), to_tsquery('simple', $1),
                          'StartSel=<b>,StopSel=</b>,MaxWords=20,MinWords=5') AS snippet
         FROM documents WHERE ${w.join(' AND ')}
        ORDER BY rank DESC, created_at DESC LIMIT 50`, p);
    res.json({ items, total: items.length, took_ms: Date.now() - t0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Картка документа (версії + коментарі)
router.get('/:id', async (req, res) => {
  try {
    const doc = await one(`SELECT * FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    delete doc.full_text_index;
    doc.versions = await q(`SELECT id, version_number, file_storage_id, file_name, file_size, comment, created_by, created_at
                              FROM document_versions WHERE document_id=$1 ORDER BY version_number DESC`, [doc.id]);
    doc.comments = await q(`SELECT id, author_id, author_name, body, created_at
                              FROM document_comments WHERE document_id=$1 ORDER BY created_at DESC`, [doc.id]);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Створення документа (метадані + опційно прив'язка до файлу files.id)
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title-required' });
    const category = CATEGORIES.includes(b.category) ? b.category : 'other';
    // дедуп по file_hash
    if (b.file_hash) {
      const dup = await one(`SELECT id FROM documents WHERE tenant_id=current_tenant_id() AND file_hash=$1 AND deleted_at IS NULL LIMIT 1`, [b.file_hash]);
      if (dup) return res.status(409).json({ error: 'duplicate', existing_id: dup.id });
    }
    const doc = await one(
      `INSERT INTO documents (category, title, description, file_storage_id, file_name, file_size, mime_type, file_hash,
                              client_id, employee_id, supplier_id, visit_id, tags, metadata, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, current_version`,
      [category, b.title, b.description || '', num(b.file_storage_id), b.file_name || null, num(b.file_size),
       b.mime_type || null, b.file_hash || null, num(b.client_id), num(b.employee_id), num(b.supplier_id),
       num(b.visit_id), JSON.stringify(jstr(b.tags, [])), JSON.stringify(jstr(b.metadata, {})), b.expires_at || null, req.user?.id ?? null]);
    // перша версія
    if (b.file_storage_id) {
      await q(`INSERT INTO document_versions (document_id, version_number, file_storage_id, file_name, file_size, mime_type, comment, created_by)
               VALUES ($1,1,$2,$3,$4,$5,$6,$7)`,
        [doc.id, num(b.file_storage_id), b.file_name || null, num(b.file_size), b.mime_type || null, 'Початкова версія', req.user?.id ?? null]);
    }
    logAction({ user: req.user, action: 'document.create', entity: 'document', entity_id: doc.id, ip: req.ip, meta: { title: b.title, category } });
    emit('document.created', { id: doc.id, category, title: b.title });
    res.status(201).json({ ok: true, id: doc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Оновлення метаданих
router.put('/:id', async (req, res) => {
  try {
    const doc = await one(`SELECT id, locked_by FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    if (doc.locked_by != null && doc.locked_by !== (req.user?.id ?? -1)) return res.status(423).json({ error: 'locked', locked_by: doc.locked_by });
    const b = req.body || {};
    const sets = []; const p = [];
    const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.category !== undefined && CATEGORIES.includes(b.category)) set('category', b.category);
    if (b.client_id !== undefined) set('client_id', num(b.client_id));
    if (b.employee_id !== undefined) set('employee_id', num(b.employee_id));
    if (b.supplier_id !== undefined) set('supplier_id', num(b.supplier_id));
    if (b.visit_id !== undefined) set('visit_id', num(b.visit_id));
    if (b.tags !== undefined) set('tags', JSON.stringify(jstr(b.tags, [])));
    if (b.metadata !== undefined) set('metadata', JSON.stringify(jstr(b.metadata, {})));
    if (b.expires_at !== undefined) { set('expires_at', b.expires_at || null); set('expiry_notified', JSON.stringify([])); }
    if (b.status !== undefined) set('status', b.status);
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    sets.push('updated_at=NOW()');
    p.push(req.params.id);
    await q(`UPDATE documents SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id()`, p);
    logAction({ user: req.user, action: 'document.update', entity: 'document', entity_id: req.params.id, ip: req.ip });
    emit('document.updated', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// М'яке видалення
router.delete('/:id', async (req, res) => {
  try {
    const r = await one(`UPDATE documents SET deleted_at=NOW(), status='deleted' WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING id`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'document.delete', entity: 'document', entity_id: req.params.id, ip: req.ip });
    emit('document.deleted', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Завантаження нової версії
router.post('/:id/upload-version', async (req, res) => {
  try {
    const doc = await one(`SELECT * FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    if (doc.locked_by != null && doc.locked_by !== (req.user?.id ?? -1)) return res.status(423).json({ error: 'locked', locked_by: doc.locked_by });
    const b = req.body || {};
    if (!b.file_storage_id) return res.status(400).json({ error: 'file_storage_id-required' });
    const nextV = doc.current_version + 1;
    await q(`INSERT INTO document_versions (document_id, version_number, file_storage_id, file_name, file_size, mime_type, comment, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, nextV, num(b.file_storage_id), b.file_name || null, num(b.file_size), b.mime_type || null, b.comment || '', req.user?.id ?? null]);
    await q(`UPDATE documents SET current_version=$1, file_storage_id=$2, file_name=COALESCE($3,file_name),
             file_size=COALESCE($4,file_size), mime_type=COALESCE($5,mime_type), file_hash=COALESCE($6,file_hash), updated_at=NOW()
             WHERE id=$7`,
      [nextV, num(b.file_storage_id), b.file_name || null, num(b.file_size), b.mime_type || null, b.file_hash || null, doc.id]);
    logAction({ user: req.user, action: 'document.version', entity: 'document', entity_id: doc.id, ip: req.ip, meta: { version: nextV } });
    emit('document.updated', { id: doc.id, version: nextV });
    res.json({ ok: true, version: nextV });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Список версій
router.get('/:id/versions', async (req, res) => {
  try {
    const rows = await q(`SELECT id, version_number, file_storage_id, file_name, file_size, mime_type, comment, created_by, created_at
                            FROM document_versions WHERE document_id=$1 ORDER BY version_number DESC`, [req.params.id]);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Відкат до версії (створює нову версію-копію)
router.post('/:id/revert', async (req, res) => {
  try {
    const doc = await one(`SELECT * FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    const target = await one(`SELECT * FROM document_versions WHERE document_id=$1 AND version_number=$2`, [doc.id, num(req.body?.version_number)]);
    if (!target) return res.status(404).json({ error: 'version-not-found' });
    const nextV = doc.current_version + 1;
    await q(`INSERT INTO document_versions (document_id, version_number, file_storage_id, file_name, file_size, mime_type, comment, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, nextV, target.file_storage_id, target.file_name, target.file_size, target.mime_type,
       `Відкат до версії ${target.version_number}`, req.user?.id ?? null]);
    await q(`UPDATE documents SET current_version=$1, file_storage_id=$2, file_name=$3, file_size=$4, mime_type=$5, updated_at=NOW() WHERE id=$6`,
      [nextV, target.file_storage_id, target.file_name, target.file_size, target.mime_type, doc.id]);
    logAction({ user: req.user, action: 'document.revert', entity: 'document', entity_id: doc.id, ip: req.ip, meta: { to: target.version_number, new: nextV } });
    emit('document.updated', { id: doc.id, version: nextV });
    res.json({ ok: true, version: nextV });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Блокування / розблокування
router.post('/:id/lock', async (req, res) => {
  try {
    const doc = await one(`SELECT locked_by FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    if (doc.locked_by != null && doc.locked_by !== (req.user?.id ?? -1)) return res.status(423).json({ error: 'already-locked', locked_by: doc.locked_by });
    await q(`UPDATE documents SET locked_by=$1, locked_at=NOW() WHERE id=$2`, [req.user?.id ?? null, req.params.id]);
    emit('document.locked', { id: Number(req.params.id), by: req.user?.id ?? null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/unlock', async (req, res) => {
  try {
    const doc = await one(`SELECT locked_by FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    await q(`UPDATE documents SET locked_by=NULL, locked_at=NULL WHERE id=$1`, [req.params.id]);
    emit('document.unlocked', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Відправка на підпис (-> MGT-07)
router.post('/:id/send-to-sign', async (req, res) => {
  try {
    const doc = await one(`SELECT id, title FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    await q(`UPDATE documents SET esign_status='pending', updated_at=NOW() WHERE id=$1`, [doc.id]);
    logAction({ user: req.user, action: 'document.send_to_sign', entity: 'document', entity_id: doc.id, ip: req.ip });
    emit('document.send_to_sign', { id: doc.id, title: doc.title, signers: req.body?.signers || [] });
    res.json({ ok: true, esign_status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Коментарі
router.get('/:id/comments', async (req, res) => {
  try {
    const rows = await q(`SELECT id, author_id, author_name, body, created_at FROM document_comments WHERE document_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/comments', async (req, res) => {
  try {
    if (!req.body?.body) return res.status(400).json({ error: 'body-required' });
    const doc = await one(`SELECT id FROM documents WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'not-found' });
    const r = await one(`INSERT INTO document_comments (document_id, author_id, author_name, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [doc.id, req.user?.id ?? null, req.user?.name || null, req.body.body]);
    res.status(201).json({ ok: true, id: r.id, created_at: r.created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ ШАБЛОНИ ═══════════════════

router.get('/templates/list', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    if (req.query.category) { p.push(req.query.category); w.push(`category=$${p.length}`); }
    if (req.query.active !== undefined) { p.push(req.query.active === '1' || req.query.active === 'true'); w.push(`active=$${p.length}`); }
    const rows = await q(`SELECT id, name, description, category, output_format, language, version, is_system, active, created_at, updated_at
                            FROM document_templates WHERE ${w.join(' AND ')} ORDER BY category, name`, p);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const tpl = await one(`SELECT * FROM document_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'not-found' });
    tpl.fields = await q(`SELECT * FROM document_template_fields WHERE template_id=$1 ORDER BY sort_order, id`, [tpl.id]);
    res.json(tpl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name-required' });
    const category = TPL_CATEGORIES.includes(b.category) ? b.category : 'other';
    const tpl = await one(
      `INSERT INTO document_templates (name, description, category, output_format, body_html, language, is_system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.name, b.description || '', category, b.output_format === 'docx' ? 'docx' : 'pdf', b.body_html || '', b.language || 'uk', !!b.is_system, req.user?.id ?? null]);
    // поля
    if (Array.isArray(b.fields)) {
      for (let i = 0; i < b.fields.length; i++) {
        const f = b.fields[i];
        if (!f.field_key || !f.field_label) continue;
        await q(`INSERT INTO document_template_fields (template_id, field_key, field_label, field_type, source_entity, source_field, is_required, default_value, format_pattern, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (template_id, field_key) DO NOTHING`,
          [tpl.id, f.field_key, f.field_label, f.field_type || 'text', f.source_entity || null, f.source_field || null, !!f.is_required, f.default_value || null, f.format_pattern || null, i]);
      }
    }
    logAction({ user: req.user, action: 'document_template.create', entity: 'document_template', entity_id: tpl.id, ip: req.ip });
    res.status(201).json({ ok: true, id: tpl.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const tpl = await one(`SELECT id, version FROM document_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'not-found' });
    const b = req.body || {};
    const sets = ['version=version+1', 'updated_at=NOW()']; const p = [];
    const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    if (b.name !== undefined) set('name', b.name);
    if (b.description !== undefined) set('description', b.description);
    if (b.category !== undefined && TPL_CATEGORIES.includes(b.category)) set('category', b.category);
    if (b.output_format !== undefined) set('output_format', b.output_format === 'docx' ? 'docx' : 'pdf');
    if (b.body_html !== undefined) set('body_html', b.body_html);
    if (b.language !== undefined) set('language', b.language);
    if (b.active !== undefined) set('active', !!b.active);
    p.push(req.params.id);
    await q(`UPDATE document_templates SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id()`, p);
    // переписати поля, якщо передані
    if (Array.isArray(b.fields)) {
      await q(`DELETE FROM document_template_fields WHERE template_id=$1`, [req.params.id]);
      for (let i = 0; i < b.fields.length; i++) {
        const f = b.fields[i];
        if (!f.field_key || !f.field_label) continue;
        await q(`INSERT INTO document_template_fields (template_id, field_key, field_label, field_type, source_entity, source_field, is_required, default_value, format_pattern, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.params.id, f.field_key, f.field_label, f.field_type || 'text', f.source_entity || null, f.source_field || null, !!f.is_required, f.default_value || null, f.format_pattern || null, i]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const r = await one(`DELETE FROM document_templates WHERE id=$1 AND tenant_id=current_tenant_id() AND is_system=FALSE RETURNING id`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found-or-system' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/templates/:id/fields', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM document_template_fields WHERE template_id=$1 ORDER BY sort_order, id`, [req.params.id]);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Зібрати значення полів: автозаповнення з сутності + manual override
async function resolveFieldValues(fields, manual = {}, entities = {}) {
  const values = {};
  const cache = {};
  for (const f of fields) {
    let val = manual[f.field_key];
    if ((val === undefined || val === null || val === '') && f.source_entity && f.source_field) {
      const table = ENTITY_TABLES[f.source_entity];
      const entId = num(entities[f.source_entity] ?? entities[f.source_entity + '_id']);
      if (table && entId) {
        const ck = f.source_entity + ':' + entId;
        if (!(ck in cache)) cache[ck] = await one(`SELECT * FROM ${table} WHERE id=$1 AND tenant_id=current_tenant_id()`, [entId]);
        if (cache[ck] && f.source_field in cache[ck]) val = cache[ck][f.source_field];
      }
    }
    if ((val === undefined || val === null || val === '') && f.default_value != null) val = f.default_value;
    values[f.field_key] = val == null ? '' : String(val);
  }
  return values;
}

function renderTemplate(html, values) {
  return String(html || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => (key in values ? values[key] : ''));
}

// Предпрогляд з тестовими/переданими даними
router.post('/templates/:id/preview', async (req, res) => {
  try {
    const tpl = await one(`SELECT * FROM document_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'not-found' });
    const fields = await q(`SELECT * FROM document_template_fields WHERE template_id=$1 ORDER BY sort_order, id`, [tpl.id]);
    const values = await resolveFieldValues(fields, req.body?.values || {}, req.body?.entities || req.body || {});
    res.json({ html: renderTemplate(tpl.body_html, values), values, fields: fields.map(f => f.field_key) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Генерація документа з шаблону -> новий documents запис
router.post('/templates/:id/generate', async (req, res) => {
  try {
    const tpl = await one(`SELECT * FROM document_templates WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'not-found' });
    const fields = await q(`SELECT * FROM document_template_fields WHERE template_id=$1 ORDER BY sort_order, id`, [tpl.id]);
    const b = req.body || {};
    const entities = b.entities || b;
    const values = await resolveFieldValues(fields, b.values || {}, entities);
    // перевірка обов'язкових
    const missing = fields.filter(f => f.is_required && !values[f.field_key]).map(f => f.field_key);
    if (missing.length) return res.status(400).json({ error: 'missing-required-fields', fields: missing });
    const html = renderTemplate(tpl.body_html, values);
    const title = b.title || `${tpl.name} — ${new Date().toLocaleDateString('uk-UA')}`;
    const doc = await one(
      `INSERT INTO documents (category, title, description, client_id, employee_id, supplier_id, visit_id,
                              metadata, is_template_generated, template_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10) RETURNING id`,
      [TPL_CATEGORIES.includes(tpl.category) && CATEGORIES.includes(tpl.category) ? tpl.category : 'other',
       title, b.description || `Згенеровано з шаблону «${tpl.name}»`,
       num(entities.client ?? entities.client_id), num(entities.employee ?? entities.employee_id),
       num(entities.supplier ?? entities.supplier_id), num(entities.visit ?? entities.visit_id),
       JSON.stringify({ generated_html: html, template_id: tpl.id, values }), tpl.id, req.user?.id ?? null]);
    logAction({ user: req.user, action: 'document.generate', entity: 'document', entity_id: doc.id, ip: req.ip, meta: { template_id: tpl.id } });
    emit('document.generated', { id: doc.id, template_id: tpl.id });
    res.status(201).json({ ok: true, id: doc.id, html });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
