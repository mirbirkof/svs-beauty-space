/* CRM Notes — заметки обратной связи из админки.
   Плавающая кнопка в кабинете: владелец/сотрудник оставляет заметку, что
   нужно поправить в CRM, система запоминает с какой страницы.
   Подключается как /api/notes в shop-api.js.

   GET    /api/notes?status=open|done|all   — список (по умолч. open)
   POST   /api/notes  {body, page_path, page_label}  — создать (status=open)
   PATCH  /api/notes/:id  {status: 'done'|'open'}     — закрыть / вернуть
   DELETE /api/notes/:id                              — удалить заметку
*/
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

// Любой авторизованный пользователь админки может работать с заметками
router.use(requirePerm());

// ── список ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    let where = '';
    if (status === 'open') where = `WHERE status='open'`;
    else if (status === 'done') where = `WHERE status='done'`;
    // status=all → без фильтра
    const r = await pool.query(
      `SELECT id, body, page_path, page_label, status,
              created_by, created_by_name, created_at,
              done_by, done_by_name, done_at
         FROM crm_notes
         ${where}
         ORDER BY (status='open') DESC, created_at DESC
         LIMIT 500`
    );
    const open = r.rows.filter((n) => n.status === 'open').length;
    res.json({ ok: true, notes: r.rows, open_count: open });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// ── создать ────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'empty-body', message: 'Текст заметки порожній' });
    if (body.length > 4000) return res.status(400).json({ error: 'too-long', message: 'Заметка задовга (макс 4000)' });
    const page_path = req.body?.page_path ? String(req.body.page_path).slice(0, 500) : null;
    const page_label = req.body?.page_label ? String(req.body.page_label).slice(0, 300) : null;
    const r = await pool.query(
      `INSERT INTO crm_notes (body, page_path, page_label, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [body, page_path, page_label, req.user?.id ?? null, req.user?.display_name || null]
    );
    logAction({ user: req.user, action: 'note.create', entity: 'crm_notes', entity_id: r.rows[0].id, ip: req.ip, meta: { page_path } });
    res.json({ ok: true, note: r.rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// ── закрыть / вернуть ──────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const status = String(req.body?.status || 'done').toLowerCase();
    if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'bad-status' });
    let r;
    if (status === 'done') {
      // Имя закрывшего: явно переданное (напр. "Jarvis 🤖" при авто-закрытии) либо текущий юзер
      const doneByName = (req.body?.done_by_name && String(req.body.done_by_name).slice(0, 100))
        || req.user?.display_name || null;
      r = await pool.query(
        `UPDATE crm_notes SET status='done', done_by=$2, done_by_name=$3, done_at=NOW()
           WHERE id=$1 RETURNING *`,
        [id, req.user?.id ?? null, doneByName]
      );
    } else {
      r = await pool.query(
        `UPDATE crm_notes SET status='open', done_by=NULL, done_by_name=NULL, done_at=NULL
           WHERE id=$1 RETURNING *`,
        [id]
      );
    }
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'note.' + status, entity: 'crm_notes', entity_id: id, ip: req.ip });
    res.json({ ok: true, note: r.rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// ── удалить ────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const r = await pool.query(`DELETE FROM crm_notes WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'note.delete', entity: 'crm_notes', entity_id: id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
