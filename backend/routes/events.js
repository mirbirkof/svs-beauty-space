/* ═══════════════════════════════════════════════════════
   INF-01 — EVENT BUS API (просмотр журнала доменных событий)
   GET  /api/events           — последние события (фильтры: type, entity, status, limit)
   GET  /api/events/types     — сводка по типам событий (для дашборда)
   POST /api/events/test      — публикация тестового события (диагностика)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const bus = require('../lib/event-bus');

const router = express.Router();
const pool = getPool();
const ADMIN = requirePerm('admin.read');

// Список событий
router.get('/', ADMIN, async (req, res) => {
  try {
    const { type, entity, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = [];
    const args = [];
    if (type)   { args.push(type);   where.push(`event_type = $${args.length}`); }
    if (entity) { args.push(entity); where.push(`entity_type = $${args.length}`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    args.push(limit);
    const sql = `SELECT id, event_type, entity_type, entity_id, actor, payload, status, handler_count, error, created_at, handled_at
                 FROM domain_events
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT $${args.length}`;
    const r = await pool.query(sql, args);
    res.json({ events: r.rows, count: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Сводка по типам (за последние 24ч и всего)
router.get('/types', ADMIN, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT event_type,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              MAX(created_at) AS last_seen
       FROM domain_events
       GROUP BY event_type
       ORDER BY last_seen DESC`
    );
    res.json({ types: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Тестовая публикация — проверка сквозного прохода шины
router.post('/test', requirePerm('admin.write'), async (req, res) => {
  try {
    const evt = await bus.emit('system.test', { note: req.body?.note || 'manual test', ts: Date.now() },
      { entityType: 'system', actor: req.user?.display_name || 'admin' });
    res.json({ ok: true, event: evt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
