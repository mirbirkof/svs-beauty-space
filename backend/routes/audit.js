/* ═══════════════════════════════════════════════════════
   MGT-10 — Полный аудит действий (Audit Log)
   Подключается как /api/audit

   Что закрывает:
   - просмотр журнала действий из таблицы audit_log (пишется lib/rbac.logAction);
   - фильтры: action, entity, user_label, диапазон дат, поиск по entity_id;
   - пагинация (limit/offset) + total;
   - фасеты для UI (?facets=1): список действий/сущностей/пользователей с счётчиками;
   - сводка активности (/stats): по дням, топ-действия, топ-пользователи;
   - детали одной записи (/:id) с распарсенным meta.

   Только чтение. Право: audit.read (миграция 086).
   Мультитенант: фильтр по tenant_id (current_tenant_id()).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use(requirePerm('audit.read'));

/* GET /api/audit — список с фильтрами и пагинацией */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const cond = ['tenant_id = current_tenant_id()'];
    const params = [];
    const add = (sql, val) => { params.push(val); cond.push(sql.replace(/\?/g, () => `$${params.length}`)); };

    if (req.query.action) add('action = ?', String(req.query.action));
    if (req.query.entity) add('entity = ?', String(req.query.entity));
    if (req.query.user) add('user_label ILIKE ?', `%${req.query.user}%`);
    if (req.query.entity_id) add('entity_id = ?', String(req.query.entity_id));
    if (req.query.from) add('created_at >= ?', req.query.from);
    if (req.query.to) add('created_at <= ?', req.query.to);
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const i = params.length;
      cond.push(`(action ILIKE $${i} OR entity ILIKE $${i} OR user_label ILIKE $${i})`);
    }

    const where = cond.join(' AND ');
    const rows = await q(`
      SELECT id, user_id, user_label, action, entity, entity_id, ip, meta, created_at
      FROM audit_log WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    const totalRow = await q(`SELECT count(*)::int n FROM audit_log WHERE ${where}`, params);

    let facets;
    if (req.query.facets === '1') {
      const [actions, entities, users] = await Promise.all([
        q(`SELECT action, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id() GROUP BY action ORDER BY n DESC LIMIT 50`),
        q(`SELECT entity, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id() AND entity IS NOT NULL GROUP BY entity ORDER BY n DESC LIMIT 50`),
        q(`SELECT user_label, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id() GROUP BY user_label ORDER BY n DESC LIMIT 50`),
      ]);
      facets = { actions, entities, users };
    }

    res.json({ rows, total: totalRow[0].n, limit, offset, facets });
  } catch (e) {
    console.error('[audit] list error:', e.message);
    res.status(500).json({ error: 'audit_failed', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

/* GET /api/audit/stats?days=30 — сводка активности */
router.get('/stats', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const [byDay, topActions, topUsers, byEntity] = await Promise.all([
      q(`SELECT date_trunc('day', created_at)::date AS day, count(*)::int n
         FROM audit_log WHERE tenant_id=current_tenant_id()
           AND created_at >= now() - ($1 || ' days')::interval
         GROUP BY day ORDER BY day`, [days]),
      q(`SELECT action, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id()
           AND created_at >= now() - ($1 || ' days')::interval
         GROUP BY action ORDER BY n DESC LIMIT 10`, [days]),
      q(`SELECT user_label, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id()
           AND created_at >= now() - ($1 || ' days')::interval
         GROUP BY user_label ORDER BY n DESC LIMIT 10`, [days]),
      q(`SELECT entity, count(*)::int n FROM audit_log WHERE tenant_id=current_tenant_id()
           AND entity IS NOT NULL AND created_at >= now() - ($1 || ' days')::interval
         GROUP BY entity ORDER BY n DESC LIMIT 10`, [days]),
    ]);
    res.json({ days, by_day: byDay, top_actions: topActions, top_users: topUsers, by_entity: byEntity });
  } catch (e) {
    console.error('[audit] stats error:', e.message);
    res.status(500).json({ error: 'audit_stats_failed', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

/* GET /api/audit/:id — детали записи */
router.get('/:id', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM audit_log WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
