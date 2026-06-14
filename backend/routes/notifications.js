/* ═══════════════════════════════════════════════════════
   COM-01 — Notification Hub: HTTP API + cron-воркер

   Подключается как /api/notifications
   Воркер очереди тикает каждую минуту (processQueue).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const hub = require('../lib/notification-hub');

const WORKER_INTERVAL = 60 * 1000; // 1 мин
let cronRef = null;

// ── Очередь / журнал ────────────────────────────────────────────────
// GET /api/notifications?status=&channel=&category=&client_id=&limit=
router.get('/', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { status, channel, category, client_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = [], args = [];
    if (status)    { args.push(status);    where.push(`status = $${args.length}`); }
    if (channel)   { args.push(channel);   where.push(`channel = $${args.length}`); }
    if (category)  { args.push(category);  where.push(`category = $${args.length}`); }
    if (client_id) { args.push(client_id); where.push(`client_id = $${args.length}`); }
    args.push(limit);
    const r = await pool.query(
      `SELECT n.id, n.client_id, c.name AS client_name, n.template_key, n.category,
              n.priority, n.channel, n.status, n.attempts, n.recipient,
              n.scheduled_at, n.sent_at, n.delivered_at, n.last_error, n.source, n.created_at
       FROM notifications n LEFT JOIN clients c ON c.id = n.client_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY n.created_at DESC LIMIT $${args.length}`, args);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/stats — аналитика доставляемости
router.get('/stats', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const byStatus = await pool.query(`SELECT status, count(*)::int c FROM notifications GROUP BY status`);
    const byChannel = await pool.query(
      `SELECT channel,
              count(*)::int total,
              count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int delivered,
              count(*) FILTER (WHERE status IN ('failed','bounced'))::int failed
       FROM notifications GROUP BY channel`);
    const today = await pool.query(
      `SELECT count(*)::int c FROM notifications WHERE created_at::date = (NOW() AT TIME ZONE 'Europe/Kyiv')::date`);
    const settings = await hub.getSettings(pool);
    const stats = {}; byStatus.rows.forEach(r => stats[r.status] = r.c);
    const channels = byChannel.rows.map(r => ({
      channel: r.channel, total: r.total, delivered: r.delivered, failed: r.failed,
      delivery_rate: r.total ? Math.round((r.delivered / r.total) * 100) : null,
    }));
    res.json({ ok: true, worker_active: !!cronRef, paused: settings.paused, today: today.rows[0].c, by_status: stats, by_channel: channels });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/send — ручная постановка в очередь
// body: { clientId?, recipient?, channel?, templateKey?, vars?, body?, category?, priority?, scheduledAt?, dedupKey? }
router.post('/send', requirePerm('notify.write'), async (req, res) => {
  try {
    const out = await hub.enqueue({ ...req.body, source: req.body.source || 'manual', createdBy: req.user?.id });
    // моментальная попытка отправки, чтобы UI сразу видел результат
    if (out.id) await hub.processQueue(5);
    res.json({ ok: !out.skipped, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/:id/retry — ручной повтор
router.post('/:id/retry', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE notifications SET status='queued', next_attempt_at=NOW(), attempts=0,
         last_error=NULL, failed_at=NULL, updated_at=NOW()
       WHERE id=$1 AND status IN ('failed','cancelled','bounced') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found-or-not-retryable' });
    const result = await hub.processQueue(5);
    res.json({ ok: true, requeued: req.params.id, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/process — ручной тик воркера
router.post('/process', requirePerm('notify.write'), async (req, res) => {
  try { res.json({ ok: true, ...(await hub.processQueue(parseInt(req.body?.limit, 10) || 30)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Настройки доставки (пауза, лимиты, DND) ─────────────────────────
router.get('/settings', requirePerm('notify.write'), async (req, res) => {
  try { res.json(await hub.getSettings(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/settings', requirePerm('settings.write'), async (req, res) => {
  try {
    const pool = getPool();
    const allowed = ['paused', 'queue_max', 'daily_limit_client', 'cooldown_minutes', 'dnd_start', 'dnd_end', 'default_chain'];
    const sets = [], args = [];
    for (const k of allowed) if (k in req.body) { args.push(req.body[k]); sets.push(`${k} = $${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    args.push(hub.DEFAULT_TENANT);
    await pool.query(`UPDATE notification_settings SET ${sets.join(', ')}, updated_at=NOW() WHERE tenant_id=$${args.length}`, args);
    res.json(await hub.getSettings(pool));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Шаблоны ─────────────────────────────────────────────────────────
router.get('/templates', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT * FROM notification_templates ORDER BY category, key, channel, lang`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// preview: рендер с тестовыми переменными
router.post('/templates/preview', requirePerm('notify.write'), async (req, res) => {
  try { res.json({ ok: true, rendered: hub.renderTemplate(req.body?.body || '', req.body?.vars || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/templates', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { key, channel = 'any', lang = 'uk', category = 'transactional', subject, body, variables } = req.body || {};
    if (!key || !body) return res.status(400).json({ error: 'key-and-body-required' });
    const r = await pool.query(
      `INSERT INTO notification_templates(key, channel, lang, category, subject, body, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid), key, channel, lang)
       DO UPDATE SET subject=EXCLUDED.subject, body=EXCLUDED.body, category=EXCLUDED.category,
                     variables=EXCLUDED.variables, version=notification_templates.version+1, updated_at=NOW()
       RETURNING *`,
      [key, channel, lang, category, subject || null, body, JSON.stringify(variables || [])]);
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/templates/:id', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`DELETE FROM notification_templates WHERE id=$1 AND is_system=FALSE RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found-or-system' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Подписки клиента / отписка ──────────────────────────────────────
router.get('/prefs/:clientId', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT * FROM notification_prefs WHERE client_id=$1`, [req.params.clientId]);
    res.json(r.rows[0] || { client_id: Number(req.params.clientId), marketing_opt_in: true, transactional_opt_in: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/prefs/:clientId', requirePerm('notify.write'), async (req, res) => {
  try {
    const pool = getPool();
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO notification_prefs(client_id, channel_priority, marketing_opt_in, transactional_opt_in, dnd_start, dnd_end, unsubscribed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (client_id) DO UPDATE SET
         channel_priority=COALESCE(EXCLUDED.channel_priority, notification_prefs.channel_priority),
         marketing_opt_in=COALESCE(EXCLUDED.marketing_opt_in, notification_prefs.marketing_opt_in),
         transactional_opt_in=COALESCE(EXCLUDED.transactional_opt_in, notification_prefs.transactional_opt_in),
         dnd_start=EXCLUDED.dnd_start, dnd_end=EXCLUDED.dnd_end,
         unsubscribed_at=EXCLUDED.unsubscribed_at, updated_at=NOW()
       RETURNING *`,
      [req.params.clientId, b.channel_priority || null, b.marketing_opt_in ?? null,
       b.transactional_opt_in ?? null, b.dnd_start ?? null, b.dnd_end ?? null,
       b.unsubscribe ? new Date() : (b.resubscribe ? null : (b.unsubscribed_at ?? null))]);
    res.json({ ok: true, prefs: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/health', (req, res) => res.json({ ok: true, worker_active: !!cronRef, channels: hub.channelStatus() }));

// ── Cron-воркер ─────────────────────────────────────────────────────
async function workerTick() {
  try {
    const r = await hub.processQueue(30);
    if (r.sent || r.failed) console.log(`[notif-hub] sent=${r.sent} failed=${r.failed} skipped=${r.skipped} picked=${r.picked}`);
  } catch (e) { console.error('[notif-hub] worker error:', e.message); }
}
function startCron() {
  if (cronRef) return;
  workerTick();
  cronRef = setInterval(workerTick, WORKER_INTERVAL);
  console.log('[notif-hub] worker started (every 60s)');
}
function stopCron() { if (cronRef) { clearInterval(cronRef); cronRef = null; } }

module.exports = router;
module.exports.startCron = startCron;
module.exports.stopCron = stopCron;
