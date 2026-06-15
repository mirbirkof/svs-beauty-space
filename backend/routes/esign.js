/* routes/esign.js — MGT-07 Електронний підпис.
   Запити на підписання (single/multi), захоплення підпису (drawn/typed/checkbox),
   криптофіксація SHA-256 хеша документа, immutable аудит-трейл, верифікація,
   аналітика. Публічне підписання за токеном (/sign/:token). Звʼязок з MGT-06:
   слухає document.send_to_sign, оновлює documents.esign_status. PDF/ZIP -> JSON/HTML
   (без зовнішніх залежностей). Доступ: GET=esign.read, мутації=esign.write. */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { emit, on } = require('../lib/event-bus');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const one = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] || null);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const sha256 = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

// Хеш документа: пріоритет file_hash -> згенерований HTML -> title+id
async function computeDocHash(documentId) {
  if (!documentId) return sha256('no-document');
  const d = await one(`SELECT id, title, file_hash, metadata FROM documents WHERE id=$1 AND tenant_id=current_tenant_id()`, [documentId]);
  if (!d) return sha256('missing-' + documentId);
  if (d.file_hash) return d.file_hash;
  const html = d.metadata && d.metadata.generated_html;
  if (html) return sha256(html);
  return sha256(`doc:${d.id}:${d.title}`);
}

async function audit(reqRow, { action, actor_type = 'system', actor_id = null, actor_name = null, signature_id = null, ip = null, ua = null, geo = null, details = null, hash = null }) {
  await q(`INSERT INTO esign_audit_trail (request_id, signature_id, action, actor_type, actor_id, actor_name, ip_address, user_agent, geolocation, details, document_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [reqRow.id, signature_id, action, actor_type, actor_id, actor_name, ip, ua, geo ? JSON.stringify(geo) : null, details ? JSON.stringify(details) : null, hash]);
}

// ── Публічні роути підписання (БЕЗ авторизації, за токеном) ──
const publicRouter = express.Router();

async function loadByToken(token) {
  const reqRow = await one(`SELECT * FROM esign_requests WHERE sign_url_token=$1`, [token]);
  if (!reqRow) return { error: 'not-found', code: 404 };
  if (reqRow.status === 'cancelled') return { error: 'cancelled', code: 410 };
  if (reqRow.status === 'completed') return { reqRow, completed: true };
  if (new Date(reqRow.expires_at) < new Date()) {
    if (reqRow.status !== 'expired') await q(`UPDATE esign_requests SET status='expired', updated_at=NOW() WHERE id=$1`, [reqRow.id]);
    return { error: 'expired', code: 410 };
  }
  return { reqRow };
}

publicRouter.get('/:token', async (req, res) => {
  try {
    const r = await loadByToken(req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const doc = r.reqRow.document_id ? await one(`SELECT id, title, category, file_storage_id, file_name, mime_type, metadata FROM documents WHERE id=$1`, [r.reqRow.document_id]) : null;
    const sigs = await q(`SELECT id, signer_name, signer_type, status, sort_order, signed_at FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.reqRow.id]);
    res.json({
      request: { id: r.reqRow.id, title: r.reqRow.title, status: r.reqRow.status, type: r.reqRow.type, expires_at: r.reqRow.expires_at },
      document: doc ? { id: doc.id, title: doc.title, category: doc.category, html: doc.metadata?.generated_html || null, file_storage_id: doc.file_storage_id, file_name: doc.file_name } : null,
      signers: sigs, completed: !!r.completed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function pickSignature(sigs, reqRow, sigId) {
  if (sigId) return sigs.find(s => s.id === Number(sigId));
  // sequential — перший непідписаний по порядку; інакше будь-який pending/viewed
  const pending = sigs.filter(s => s.status === 'pending' || s.status === 'viewed').sort((a, b) => a.sort_order - b.sort_order);
  if (reqRow.type === 'multi_sequential') return pending[0];
  return pending[0];
}

publicRouter.post('/:token/view', async (req, res) => {
  try {
    const r = await loadByToken(req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const sigs = await q(`SELECT * FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.reqRow.id]);
    const sig = pickSignature(sigs, r.reqRow, req.body?.signature_id);
    if (sig && sig.status === 'pending') await q(`UPDATE esign_signatures SET status='viewed', updated_at=NOW() WHERE id=$1`, [sig.id]);
    await audit(r.reqRow, { action: 'document_viewed', actor_type: 'client', actor_name: sig?.signer_name, signature_id: sig?.id, ip: req.ip, ua: req.headers['user-agent'], geo: req.body?.geolocation, hash: r.reqRow.document_hash });
    emit('esign.document_viewed', { request_id: r.reqRow.id, signature_id: sig?.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

publicRouter.post('/:token/sign', async (req, res) => {
  try {
    const r = await loadByToken(req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const b = req.body || {};
    const sigs = await q(`SELECT * FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.reqRow.id]);
    const sig = pickSignature(sigs, r.reqRow, b.signature_id);
    if (!sig) return res.status(409).json({ error: 'no-pending-signature' });
    if (r.reqRow.type === 'multi_sequential') {
      const earlier = sigs.filter(s => s.sort_order < sig.sort_order && s.status !== 'signed');
      if (earlier.length) return res.status(409).json({ error: 'awaiting-previous-signer', waiting_for: earlier[0].signer_name });
    }
    if (!['drawn', 'typed', 'checkbox'].includes(b.signature_type)) return res.status(400).json({ error: 'signature_type-required (drawn|typed|checkbox)' });
    const docHash = await computeDocHash(r.reqRow.document_id);
    await q(`UPDATE esign_signatures SET status='signed', signed_at=NOW(), signature_type=$1, signature_image_svg=$2,
             signature_png_id=$3, document_hash=$4, signer_name=COALESCE(NULLIF($5,''),signer_name),
             signer_email=COALESCE($6,signer_email), signer_phone=COALESCE($7,signer_phone),
             ip_address=$8, user_agent=$9, device_info=$10, geolocation=$11, updated_at=NOW() WHERE id=$12`,
      [b.signature_type, b.signature_svg || null, num(b.signature_png_id), docHash, b.signer_name || '',
       b.signer_email || null, b.signer_phone || null, req.ip, req.headers['user-agent'],
       b.device_info ? JSON.stringify(b.device_info) : null, b.geolocation ? JSON.stringify(b.geolocation) : null, sig.id]);
    await audit(r.reqRow, { action: 'signed', actor_type: 'client', actor_name: b.signer_name || sig.signer_name, signature_id: sig.id, ip: req.ip, ua: req.headers['user-agent'], geo: b.geolocation, hash: docHash, details: { signature_type: b.signature_type } });
    emit('esign.signed', { request_id: r.reqRow.id, signature_id: sig.id });
    // всі підписали?
    const remaining = await one(`SELECT COUNT(*)::int n FROM esign_signatures WHERE request_id=$1 AND status<>'signed'`, [r.reqRow.id]);
    if (remaining.n === 0) {
      await q(`UPDATE esign_requests SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`, [r.reqRow.id]);
      if (r.reqRow.document_id) await q(`UPDATE documents SET esign_status='signed', updated_at=NOW() WHERE id=$1`, [r.reqRow.document_id]);
      await audit(r.reqRow, { action: 'completed', actor_type: 'system', hash: docHash });
      emit('esign.all_signed', { request_id: r.reqRow.id, document_id: r.reqRow.document_id });
      emit('document.signed', { id: r.reqRow.document_id, request_id: r.reqRow.id });
    }
    res.json({ ok: true, completed: remaining.n === 0, document_hash: docHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

publicRouter.post('/:token/reject', async (req, res) => {
  try {
    const r = await loadByToken(req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const b = req.body || {};
    if (!b.reason) return res.status(400).json({ error: 'reason-required' });
    const sigs = await q(`SELECT * FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.reqRow.id]);
    const sig = pickSignature(sigs, r.reqRow, b.signature_id) || sigs[0];
    if (sig) await q(`UPDATE esign_signatures SET status='rejected', rejected_at=NOW(), reject_reason=$1, ip_address=$2, user_agent=$3, updated_at=NOW() WHERE id=$4`,
      [b.reason, req.ip, req.headers['user-agent'], sig.id]);
    await q(`UPDATE esign_requests SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1, updated_at=NOW() WHERE id=$2`, [b.reason, r.reqRow.id]);
    if (r.reqRow.document_id) await q(`UPDATE documents SET esign_status='rejected', updated_at=NOW() WHERE id=$1`, [r.reqRow.document_id]);
    await audit(r.reqRow, { action: 'rejected', actor_type: 'client', actor_name: sig?.signer_name, signature_id: sig?.id, ip: req.ip, ua: req.headers['user-agent'], details: { reason: b.reason } });
    emit('esign.rejected', { request_id: r.reqRow.id, reason: b.reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use('/sign', publicRouter);

// ── Захищені роути ──
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'esign.read' : 'esign.write';
  return requirePerm(perm)(req, res, next);
});

// Список запитів
router.get('/requests', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.status) add('status = ?', req.query.status);
    if (req.query.document_id) add('document_id = ?', num(req.query.document_id));
    if (req.query.visit_id) add('visit_id = ?', num(req.query.visit_id));
    const items = await q(
      `SELECT r.*, (SELECT COUNT(*)::int FROM esign_signatures s WHERE s.request_id=r.id) signers_total,
              (SELECT COUNT(*)::int FROM esign_signatures s WHERE s.request_id=r.id AND s.status='signed') signers_done
         FROM esign_requests r WHERE ${w.join(' AND ')} ORDER BY created_at DESC
        LIMIT ${Math.min(num(req.query.limit) || 50, 200)} OFFSET ${num(req.query.offset) || 0}`, p);
    res.json({ items, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Аналітика (ДО /requests/:id не потрібно — інший префікс)
router.get('/analytics', async (req, res) => {
  try {
    const a = await one(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status='completed')::int completed,
              COUNT(*) FILTER (WHERE status='pending')::int pending,
              COUNT(*) FILTER (WHERE status='cancelled')::int cancelled,
              COUNT(*) FILTER (WHERE status='expired')::int expired,
              AVG(EXTRACT(EPOCH FROM (completed_at-created_at))/3600) FILTER (WHERE completed_at IS NOT NULL) avg_hours_to_complete
         FROM esign_requests WHERE tenant_id=current_tenant_id()`);
    res.json({ ...a, avg_hours_to_complete: a.avg_hours_to_complete ? Number(a.avg_hours_to_complete).toFixed(2) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Список підписів
router.get('/signatures', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.client_id) add('signer_client_id = ?', num(req.query.client_id));
    if (req.query.status) add('status = ?', req.query.status);
    const items = await q(`SELECT id, request_id, signer_type, signer_name, signature_type, status, signed_at, document_hash
                             FROM esign_signatures WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, p);
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Створити запит
async function createRequest(b, user) {
  const docHash = await computeDocHash(num(b.document_id));
  const token = newToken();
  const ttl = num(b.ttl_hours) || 72;
  const r = await one(
    `INSERT INTO esign_requests (document_id, title, type, signing_method, sign_url_token, expires_at, visit_id, initiated_by, document_hash, metadata, status)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' hours')::interval, $7,$8,$9,$10,'draft') RETURNING *`,
    [num(b.document_id), b.title || 'Запит на підписання', b.type || 'single', b.signing_method || 'web_link',
     token, String(ttl), num(b.visit_id), user?.id ?? null, docHash, JSON.stringify(b.metadata || {})]);
  // підписанти
  const signers = Array.isArray(b.signers) && b.signers.length ? b.signers : [{ signer_type: 'client', signer_name: b.signer_name || '', signer_client_id: b.client_id, signer_phone: b.signer_phone, signer_email: b.signer_email }];
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    await q(`INSERT INTO esign_signatures (request_id, signer_type, signer_client_id, signer_employee_id, signer_name, signer_email, signer_phone, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, s.signer_type || 'client', num(s.signer_client_id ?? s.client_id), num(s.signer_employee_id ?? s.employee_id), s.signer_name || '', s.signer_email || null, s.signer_phone || null, i]);
  }
  await audit(r, { action: 'request_created', actor_type: 'employee', actor_id: user?.id ?? null, actor_name: user?.name, hash: docHash });
  emit('esign.request_created', { request_id: r.id, document_id: r.document_id });
  return r;
}

router.post('/requests', async (req, res) => {
  try {
    const r = await createRequest(req.body || {}, req.user);
    logAction({ user: req.user, action: 'esign.request_create', entity: 'esign_request', entity_id: r.id, ip: req.ip });
    res.status(201).json({ ok: true, id: r.id, sign_url_token: r.sign_url_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Масове створення
router.post('/requests/bulk', async (req, res) => {
  try {
    const items = req.body?.requests || [];
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'requests-array-required' });
    const created = [];
    for (const b of items) { const r = await createRequest(b, req.user); created.push({ id: r.id, token: r.sign_url_token }); }
    res.status(201).json({ ok: true, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Деталі запиту
router.get('/requests/:id', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    r.signatures = await q(`SELECT id, signer_type, signer_client_id, signer_employee_id, signer_name, signature_type, status, signed_at, rejected_at, reject_reason, ip_address, sort_order FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.id]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Оновити (до відправки)
router.put('/requests/:id', async (req, res) => {
  try {
    const r = await one(`SELECT status FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    if (r.status !== 'draft') return res.status(409).json({ error: 'only-draft-editable', status: r.status });
    const b = req.body || {}; const sets = []; const p = [];
    const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.type !== undefined) set('type', b.type);
    if (b.signing_method !== undefined) set('signing_method', b.signing_method);
    if (b.visit_id !== undefined) set('visit_id', num(b.visit_id));
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    sets.push('updated_at=NOW()'); p.push(req.params.id);
    await q(`UPDATE esign_requests SET ${sets.join(', ')} WHERE id=$${p.length}`, p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Відправити
router.post('/requests/:id/send', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    if (!['draft', 'pending'].includes(r.status)) return res.status(409).json({ error: 'cannot-send', status: r.status });
    await q(`UPDATE esign_requests SET status='pending', updated_at=NOW() WHERE id=$1`, [r.id]);
    await audit(r, { action: 'request_sent', actor_type: 'employee', actor_id: req.user?.id ?? null, actor_name: req.user?.name, hash: r.document_hash });
    emit('esign.request_sent', { request_id: r.id, token: r.sign_url_token, method: r.signing_method });
    res.json({ ok: true, sign_url_token: r.sign_url_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Відкликати
router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    if (r.status === 'completed') return res.status(409).json({ error: 'already-completed' });
    await q(`UPDATE esign_requests SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1, updated_at=NOW() WHERE id=$2`, [req.body?.reason || '', r.id]);
    await audit(r, { action: 'cancelled', actor_type: 'employee', actor_id: req.user?.id ?? null, actor_name: req.user?.name, details: { reason: req.body?.reason } });
    emit('esign.cancelled', { request_id: r.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Нагадування
router.post('/requests/:id/remind', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    if (r.status !== 'pending') return res.status(409).json({ error: 'not-pending' });
    await q(`UPDATE esign_requests SET reminder_sent=TRUE, updated_at=NOW() WHERE id=$1`, [r.id]);
    await audit(r, { action: 'reminder_sent', actor_type: 'employee', actor_id: req.user?.id ?? null });
    emit('esign.reminder_sent', { request_id: r.id, token: r.sign_url_token });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Аудит-трейл
router.get('/requests/:id/audit-trail', async (req, res) => {
  try {
    const r = await one(`SELECT id FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    const items = await q(`SELECT id, signature_id, action, actor_type, actor_name, ip_address, user_agent, geolocation, details, document_hash, created_at
                             FROM esign_audit_trail WHERE request_id=$1 ORDER BY created_at`, [r.id]);
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Аудит-трейл як людиночитаний HTML (замість PDF — без залежностей)
router.get('/requests/:id/audit-trail/pdf', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    const items = await q(`SELECT * FROM esign_audit_trail WHERE request_id=$1 ORDER BY created_at`, [r.id]);
    const rows = items.map(i => `<tr><td>${new Date(i.created_at).toISOString()}</td><td>${i.action}</td><td>${i.actor_name || i.actor_type || ''}</td><td>${i.ip_address || ''}</td></tr>`).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><meta charset=utf-8><title>Аудит-трейл #${r.id}</title>
<h2>Аудит-трейл підписання: ${r.title}</h2><p>Хеш документа: <code>${r.document_hash}</code></p>
<table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Час (UTC)</th><th>Дія</th><th>Актор</th><th>IP</th></tr>${rows}</table>`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Сертифікат підписання (JSON-структура доказової бази)
router.get('/requests/:id/certificate', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    const sigs = await q(`SELECT signer_name, signer_type, signature_type, signed_at, document_hash, ip_address, user_agent, device_info, geolocation FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.id]);
    res.json({ certificate: { request_id: r.id, title: r.title, document_id: r.document_id, document_hash: r.document_hash, status: r.status, completed_at: r.completed_at, signatures: sigs } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Доказова база (JSON — документ + підписи + аудит + хеші)
router.get('/requests/:id/evidence', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    const doc = r.document_id ? await one(`SELECT id, title, category, file_storage_id, file_hash, metadata FROM documents WHERE id=$1`, [r.document_id]) : null;
    const sigs = await q(`SELECT * FROM esign_signatures WHERE request_id=$1 ORDER BY sort_order`, [r.id]);
    const trail = await q(`SELECT * FROM esign_audit_trail WHERE request_id=$1 ORDER BY created_at`, [r.id]);
    res.json({ evidence: { request: r, document: doc, signatures: sigs, audit_trail: trail, exported_at: new Date().toISOString() } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Верифікація: поточний хеш документа == зафіксований при підписанні
router.post('/requests/:id/verify', async (req, res) => {
  try {
    const r = await one(`SELECT * FROM esign_requests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not-found' });
    const currentHash = await computeDocHash(r.document_id);
    const sigs = await q(`SELECT id, signer_name, document_hash, status FROM esign_signatures WHERE request_id=$1`, [r.id]);
    const checks = sigs.map(s => ({ signature_id: s.id, signer: s.signer_name, status: s.status, hash_match: s.document_hash ? s.document_hash === currentHash : null }));
    const tampered = checks.some(c => c.hash_match === false);
    res.json({ ok: true, current_hash: currentHash, request_hash: r.document_hash, request_hash_match: r.document_hash === currentHash, tampered, signatures: checks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Слухач події від MGT-06: автостворення draft-запиту ──
on('document.send_to_sign', async (payload) => {
  try {
    const docId = payload?.id;
    if (!docId) return;
    // tenant контекст у обробнику недоступний напряму — використовуємо документ для визначення
    const docHash = await computeDocHash(docId).catch(() => '');
    // створюємо лише якщо ще немає активного запиту
    const exists = await one(`SELECT id FROM esign_requests WHERE document_id=$1 AND status IN ('draft','pending') LIMIT 1`, [docId]).catch(() => null);
    if (exists) return;
    const token = newToken();
    const r = await one(`INSERT INTO esign_requests (document_id, title, type, signing_method, sign_url_token, document_hash, status)
                          VALUES ($1,$2,'single','web_link',$3,$4,'draft') RETURNING id`,
      [docId, payload.title || 'Запит на підписання', token, docHash]).catch(() => null);
    if (r) {
      const signers = Array.isArray(payload.signers) ? payload.signers : [];
      for (let i = 0; i < (signers.length || 1); i++) {
        const s = signers[i] || {};
        await q(`INSERT INTO esign_signatures (request_id, signer_type, signer_client_id, signer_name, sort_order) VALUES ($1,$2,$3,$4,$5)`,
          [r.id, s.signer_type || 'client', num(s.client_id), s.signer_name || '', i]).catch(() => {});
      }
      emit('esign.request_created', { request_id: r.id, document_id: docId, auto: true });
    }
  } catch (_) { /* listener не має валити процес */ }
});

module.exports = router;
