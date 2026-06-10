/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — File Storage (M28)
   POST   /api/files/upload          — загрузка (multipart, поле "file")
   GET    /api/files/:id             — скачать/отдать файл
   GET    /api/files/:id/meta        — метаданные
   GET    /api/files?entity_type=&entity_id= — список по сущности
   DELETE /api/files/:id             — мягкое удаление
   Хранение: uploads/<tenant>/<aa>/<sha256><ext> (дедуп по хэшу)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { getTenantId, DEFAULT_TENANT_ID } = require('../lib/tenant');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const MAX_SIZE = 15 * 1024 * 1024; // 15MB

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
  'application/pdf', 'text/csv', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'text/csv': '.csv', 'text/plain': '.txt',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1 },
});

function safeName(name) {
  return String(name || 'file').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200);
}

// multer кидает ошибку ДО хендлера — перехватываем сами, чтобы отдать честный 413
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file-too-large', max_mb: MAX_SIZE / 1024 / 1024 });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// ── загрузка ────────────────────────────────────────────
router.post('/upload', requirePerm('file.write'), uploadSingle, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no-file (multipart field "file")' });
    const { buffer, mimetype, originalname, size } = req.file;
    if (!ALLOWED_MIME.has(mimetype)) {
      return res.status(415).json({ error: 'mime-not-allowed', mime: mimetype });
    }

    const tenantId = getTenantId() || DEFAULT_TENANT_ID;
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const pool = getPool();

    // дедуп: такой файл уже есть у тенанта — возвращаем существующий
    const dup = await pool.query(
      `SELECT id, storage_path FROM files WHERE tenant_id=$1 AND sha256=$2 AND deleted_at IS NULL LIMIT 1`,
      [tenantId, sha]
    );
    if (dup.rows[0]) {
      return res.json({ ok: true, id: dup.rows[0].id, deduplicated: true });
    }

    const ext = EXT_BY_MIME[mimetype] || (path.extname(originalname || '').toLowerCase().slice(0, 10) || '.bin');
    const rel = path.join(tenantId, sha.slice(0, 2), sha + ext);
    const abs = path.join(UPLOAD_ROOT, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buffer);

    const { entity_type, entity_id, is_public } = req.body || {};
    const r = await pool.query(
      `INSERT INTO files (file_name, mime_type, size_bytes, sha256, storage_path, entity_type, entity_id, owner_user_id, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [safeName(originalname), mimetype, size, sha, rel,
       entity_type || null, entity_id || null, req.user?.id || null, is_public === 'true' || is_public === true]
    );
    logAction({ user: req.user, action: 'file.upload', entity: 'file', entity_id: r.rows[0].id, ip: req.ip, meta: { name: safeName(originalname), size } });
    res.status(201).json({ ok: true, id: r.rows[0].id, size, mime: mimetype });
  } catch (e) {
    if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file-too-large', max_mb: MAX_SIZE / 1024 / 1024 });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── список по сущности ──────────────────────────────────
router.get('/', requirePerm('file.read'), async (req, res) => {
  try {
    const { entity_type, entity_id, limit = 50, offset = 0 } = req.query;
    const cond = ['deleted_at IS NULL'];
    const vals = [];
    if (entity_type) { vals.push(entity_type); cond.push(`entity_type=$${vals.length}`); }
    if (entity_id) { vals.push(entity_id); cond.push(`entity_id=$${vals.length}`); }
    vals.push(Math.min(+limit || 50, 200), +offset || 0);
    const r = await getPool().query(
      `SELECT id, file_name, mime_type, size_bytes, entity_type, entity_id, is_public, created_at
         FROM files WHERE ${cond.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );
    res.json({ items: r.rows, total: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── метаданные ──────────────────────────────────────────
router.get('/:id/meta', requirePerm('file.read'), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT id, file_name, mime_type, size_bytes, sha256, entity_type, entity_id, is_public, created_at
         FROM files WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── отдать файл (public — без авторизации, private — с правом) ──
router.get('/:id', async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT file_name, mime_type, storage_path, is_public FROM files WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id]);
    const f = r.rows[0];
    if (!f) return res.status(404).json({ error: 'not-found' });
    if (!f.is_public) {
      // приватный — требуем file.read
      return requirePerm('file.read')(req, res, () => sendFile(res, f));
    }
    sendFile(res, f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function sendFile(res, f) {
  const abs = path.join(UPLOAD_ROOT, f.storage_path);
  if (!abs.startsWith(UPLOAD_ROOT) || !fs.existsSync(abs)) {
    return res.status(410).json({ error: 'file-gone' });
  }
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.file_name)}"`);
  res.setHeader('Cache-Control', f.is_public ? 'public, max-age=86400' : 'private, no-cache');
  fs.createReadStream(abs).pipe(res);
}

// ── мягкое удаление ─────────────────────────────────────
router.delete('/:id', requirePerm('file.write'), async (req, res) => {
  try {
    const r = await getPool().query(
      `UPDATE files SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'file.delete', entity: 'file', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
