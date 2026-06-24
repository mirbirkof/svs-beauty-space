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
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
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
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// Тестовая публикация — проверка сквозного прохода шины
router.post('/test', requirePerm('admin.write'), async (req, res) => {
  try {
    const evt = await bus.emit('system.test', { note: req.body?.note || 'manual test', ts: Date.now() },
      { entityType: 'system', actor: req.user?.display_name || 'admin' });
    res.json({ ok: true, event: evt });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

const WRITE = requirePerm('admin.write');
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/* ═══ INF-01 дотягування: реєстр типів, підписки, DLQ, replay ═══ */

// ── Реєстр типів подій ──
router.get('/registry', ADMIN, async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.domain) { params.push(req.query.domain); wh.push(`domain=$${params.length}`); }
    if (req.query.is_active !== undefined) { params.push(req.query.is_active === 'true' || req.query.is_active === '1'); wh.push(`is_active=$${params.length}`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const rows = await q(`SELECT * FROM event_types ${where} ORDER BY domain, name`, params);
    res.json({ data: rows, meta: { total: rows.length } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/registry', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.domain) return res.status(400).json({ error: 'name_and_domain_required' });
    const row = (await q(
      `INSERT INTO event_types (name, domain, version, json_schema, description, retention_hours)
       VALUES ($1,$2,COALESCE($3,1),COALESCE($4,'{}')::jsonb,$5,COALESCE($6,168))
       ON CONFLICT (name) DO UPDATE SET domain=EXCLUDED.domain, version=event_types.version+1,
         json_schema=EXCLUDED.json_schema, description=EXCLUDED.description,
         retention_hours=EXCLUDED.retention_hours, updated_at=now()
       RETURNING *`,
      [b.name, b.domain, b.version, b.json_schema ? JSON.stringify(b.json_schema) : null, b.description || null, b.retention_hours]))[0];
    res.status(201).json({ data: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.put('/registry/:id(\\d+)', WRITE, async (req, res) => {
  try {
    const allowed = ['domain', 'json_schema', 'description', 'is_active', 'retention_hours'];
    const sets = [], params = [];
    for (const k of allowed) if (req.body[k] !== undefined) {
      params.push(k === 'json_schema' ? JSON.stringify(req.body[k]) : req.body[k]);
      sets.push(`${k}=$${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE event_types SET ${sets.join(', ')}, version=version+1, updated_at=now() WHERE id=$${params.length} RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.delete('/registry/:id(\\d+)', WRITE, async (req, res) => {
  try {
    const row = (await q(`UPDATE event_types SET is_active=false, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── Підписки ──
router.get('/subscriptions', ADMIN, async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.subscriber_name) { params.push(req.query.subscriber_name); wh.push(`subscriber_name=$${params.length}`); }
    if (req.query.event_type_name) { params.push(req.query.event_type_name); wh.push(`event_type_name=$${params.length}`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const rows = await q(`SELECT * FROM event_subscriptions ${where} ORDER BY subscriber_name, event_type_name`, params);
    res.json({ data: rows, meta: { total: rows.length } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/subscriptions', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.event_type_name || !b.subscriber_name) return res.status(400).json({ error: 'event_type_name_and_subscriber_name_required' });
    const row = (await q(
      `INSERT INTO event_subscriptions (event_type_name, subscriber_name, subject_pattern, consumer_group, max_retries, retry_delay_ms, timeout_ms)
       VALUES ($1,$2,COALESCE($3,'*'),COALESCE($4,'default'),COALESCE($5,5),COALESCE($6,1000),COALESCE($7,30000))
       ON CONFLICT (event_type_name, subscriber_name) DO UPDATE SET subject_pattern=EXCLUDED.subject_pattern,
         consumer_group=EXCLUDED.consumer_group, max_retries=EXCLUDED.max_retries,
         retry_delay_ms=EXCLUDED.retry_delay_ms, timeout_ms=EXCLUDED.timeout_ms, is_active=true, updated_at=now()
       RETURNING *`,
      [b.event_type_name, b.subscriber_name, b.subject_pattern, b.consumer_group, b.max_retries, b.retry_delay_ms, b.timeout_ms]))[0];
    res.status(201).json({ data: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.put('/subscriptions/:id(\\d+)', WRITE, async (req, res) => {
  try {
    const allowed = ['subject_pattern', 'consumer_group', 'max_retries', 'retry_delay_ms', 'timeout_ms', 'is_active'];
    const sets = [], params = [];
    for (const k of allowed) if (req.body[k] !== undefined) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE event_subscriptions SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length} RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.delete('/subscriptions/:id(\\d+)', WRITE, async (req, res) => {
  try {
    const row = (await q(`DELETE FROM event_subscriptions WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── Dead Letter Queue ──
// Підтягнути у DLQ події, що впали в обробці (status='failed') і ще не в DLQ
router.post('/dlq/sync', WRITE, async (req, res) => {
  try {
    const rows = await q(
      `INSERT INTO dead_letter_queue (original_event_id, event_type, tenant_id, event_payload, error_message, retry_count, original_ts)
       SELECT de.id, de.event_type, de.tenant_id, COALESCE(de.payload,'{}'::jsonb), de.error, de.handler_count, de.created_at
         FROM domain_events de
        WHERE de.status='failed'
          AND NOT EXISTS (SELECT 1 FROM dead_letter_queue d WHERE d.original_event_id=de.id)
       RETURNING id`);
    res.json({ ok: true, added: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/dlq', ADMIN, async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.status) { params.push(req.query.status); wh.push(`status=$${params.length}`); }
    if (req.query.event_type) { params.push(req.query.event_type); wh.push(`event_type=$${params.length}`); }
    if (req.query.failed_from) { params.push(req.query.failed_from); wh.push(`failed_at >= $${params.length}::date`); }
    if (req.query.failed_to) { params.push(req.query.failed_to); wh.push(`failed_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.per_page, 10) || 50, 200);
    const rows = await q(`SELECT * FROM dead_letter_queue ${where} ORDER BY failed_at DESC LIMIT ${limit}`, params);
    const total = (await q(`SELECT COUNT(*)::int AS c FROM dead_letter_queue ${where}`, params))[0].c;
    res.json({ data: rows, meta: { total, per_page: limit } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

async function reprocessDlqRow(row) {
  // повторно публікуємо подію через шину; bus сам перепише статус domain_events
  await bus.emit(row.event_type, row.event_payload || {}, {
    actor: 'dlq-reprocess', tenantId: row.tenant_id || undefined
  });
  await pool.query(`UPDATE dead_letter_queue SET status='reprocessed', reprocessed_at=now(), retry_count=retry_count+1 WHERE id=$1`, [row.id]);
}

router.post('/dlq/:id(\\d+)/reprocess', WRITE, async (req, res) => {
  try {
    const row = (await q(`SELECT * FROM dead_letter_queue WHERE id=$1 AND status='pending'`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found_or_not_pending' });
    await reprocessDlqRow(row);
    res.json({ ok: true, reprocessed: row.id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/dlq/:id(\\d+)/discard', WRITE, async (req, res) => {
  try {
    const row = (await q(`UPDATE dead_letter_queue SET status='discarded' WHERE id=$1 AND status='pending' RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found_or_not_pending' });
    res.json({ ok: true, discarded: row.id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/dlq/reprocess-all', WRITE, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM dead_letter_queue WHERE status='pending' ORDER BY failed_at LIMIT 500`);
    let ok = 0, fail = 0;
    for (const row of rows) {
      try { await reprocessDlqRow(row); ok++; }
      catch (err) { fail++; console.error('[dlq-reprocess]', err.message); }
    }
    res.json({ ok: true, reprocessed: ok, failed: fail });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── Replay ──
router.post('/replay', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.replay_from || !b.replay_to) return res.status(400).json({ error: 'replay_from_and_replay_to_required' });
    const dryRun = !!b.is_dry_run;
    // лічимо що під replay
    const params = [b.replay_from, b.replay_to], wh = [`created_at >= $1`, `created_at <= $2`];
    if (b.event_type) { params.push(b.event_type); wh.push(`event_type=$${params.length}`); }
    if (b.tenant_id) { params.push(b.tenant_id); wh.push(`tenant_id=$${params.length}`); }
    const where = wh.join(' AND ');
    const total = (await q(`SELECT COUNT(*)::int AS c FROM domain_events WHERE ${where}`, params))[0].c;
    const job = (await q(
      `INSERT INTO event_replay_log (initiated_by, event_type, tenant_id, replay_from, replay_to, filter_criteria, total_events, status, is_dry_run, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,now()) RETURNING *`,
      [req.user?.display_name || 'admin', b.event_type || null, b.tenant_id || null, b.replay_from, b.replay_to,
       b.filter_criteria ? JSON.stringify(b.filter_criteria) : null, total, dryRun]))[0];
    // синхронний replay (single-salon, малий обсяг)
    let replayed = 0, failed = 0;
    if (!dryRun) {
      const events = await q(`SELECT event_type, entity_type, entity_id, actor, payload, tenant_id FROM domain_events WHERE ${where} ORDER BY created_at LIMIT 5000`, params);
      for (const ev of events) {
        try {
          await bus.emit(ev.event_type, ev.payload || {}, { entityType: ev.entity_type, entityId: ev.entity_id, actor: 'replay', tenantId: ev.tenant_id || undefined });
          replayed++;
        } catch (err) { failed++; console.error('[replay]', err.message); }
      }
    }
    const done = (await q(
      `UPDATE event_replay_log SET status='completed', replayed_events=$2, failed_events=$3, completed_at=now() WHERE id=$1 RETURNING *`,
      [job.id, replayed, failed]))[0];
    res.status(202).json({ data: done });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/replay', ADMIN, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM event_replay_log ORDER BY created_at DESC LIMIT 100`);
    res.json({ data: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/replay/:id(\\d+)', ADMIN, async (req, res) => {
  try {
    const row = (await q(`SELECT * FROM event_replay_log WHERE id=$1`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.post('/replay/:id(\\d+)/cancel', WRITE, async (req, res) => {
  try {
    const row = (await q(`UPDATE event_replay_log SET status='cancelled', completed_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found_or_finished' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── Моніторинг (з domain_events; зовнішні NATS-метрики = стаб) ──
router.get('/health', ADMIN, async (req, res) => {
  try {
    const s = (await q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              COUNT(*) FILTER (WHERE created_at > now()-INTERVAL '1 hour')::int AS last_1h
         FROM domain_events`))[0];
    const dlq = (await q(`SELECT COUNT(*)::int AS pending FROM dead_letter_queue WHERE status='pending'`))[0].pending;
    const health = dlq > 50 || s.failed > 100 ? 'warning' : 'ok';
    res.json({ status: health, transport: 'in-process (NATS/Redis — external stub)', events_total: s.total, events_failed: s.failed, events_last_1h: s.last_1h, dlq_pending: dlq });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/streams', ADMIN, async (req, res) => {
  try {
    const rows = await q(
      `SELECT split_part(event_type,'.',1) AS domain, COUNT(*)::int AS messages_total,
              COUNT(*) FILTER (WHERE created_at > now()-INTERVAL '24 hours')::int AS messages_24h,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed
         FROM domain_events GROUP BY split_part(event_type,'.',1) ORDER BY messages_total DESC`);
    res.json({ streams: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
