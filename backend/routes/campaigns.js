/* ═══════════════════════════════════════════════════════
   MKT-03 — Маркетинговые кампании (рассылки на сегменты)
   Подключается как /api/campaigns

   Запуск: резолвим аудиторию сегмента → ставим каждому клиенту
   уведомление в Notification Hub (category=marketing). Hub сам
   соблюдает rate-limit, opt-out, DND, throttling и трекинг доставки.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const seg = require('../lib/segments');
const hub = require('../lib/notification-hub');

router.get('/', requirePerm('promo.write'), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT c.*, s.name AS segment_name FROM campaigns c
       LEFT JOIN segments s ON s.id=c.segment_id ORDER BY c.created_at DESC`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const pool = getPool();
    const c = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'not-found' });
    // статистика доставки по уведомлениям этой кампании
    const stats = await pool.query(
      `SELECT status, count(*)::int n FROM notifications WHERE source=$1 GROUP BY status`,
      ['campaign:' + req.params.id]);
    const byStatus = {}; stats.rows.forEach(r => byStatus[r.status] = r.n);
    res.json({ campaign: c.rows[0], delivery: byStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePerm('promo.write'), async (req, res) => {
  try {
    const { name, segment_id, preset_key, channel = 'telegram', template_key, body, vars, scheduled_at } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name-required' });
    if (!template_key && !body) return res.status(400).json({ error: 'template-or-body-required' });
    if (!segment_id && !preset_key) return res.status(400).json({ error: 'segment-or-preset-required' });
    const r = await getPool().query(
      `INSERT INTO campaigns(name, segment_id, preset_key, channel, template_key, body, vars, scheduled_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, segment_id || null, preset_key || null, channel, template_key || null, body || null,
       JSON.stringify(vars || {}), scheduled_at || null, scheduled_at ? 'scheduled' : 'draft', req.user?.id || null]);
    res.json({ ok: true, campaign: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const r = await getPool().query(`DELETE FROM campaigns WHERE id=$1 AND status IN ('draft','scheduled','cancelled') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not-found-or-running' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Запуск кампании: ставим уведомления в Hub для каждого клиента сегмента
async function launchCampaign(id) {
  const pool = getPool();
  const c = (await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [id])).rows[0];
  if (!c) throw new Error('not-found');
  if (c.status === 'running' || c.status === 'done') throw new Error('already-' + c.status);

  const segment = c.segment_id
    ? (await pool.query(`SELECT * FROM segments WHERE id=$1`, [c.segment_id])).rows[0]
    : { type: 'preset', preset_key: c.preset_key };
  if (!segment) throw new Error('segment-not-found');

  const members = await seg.membersOf(segment, { limit: 5000 });
  await pool.query(`UPDATE campaigns SET status='running', launched_at=NOW(), audience_size=$2, updated_at=NOW() WHERE id=$1`, [id, members.length]);

  let enqueued = 0, skipped = 0;
  for (const m of members) {
    const r = await hub.enqueue({
      clientId: m.id,
      channel: c.channel === 'any' ? undefined : c.channel,
      templateKey: c.template_key || undefined,
      body: c.template_key ? undefined : c.body,
      vars: { client: m.name || '', ...(c.vars || {}) },
      category: 'marketing', priority: 'low',
      source: 'campaign:' + id,
      dedupKey: `campaign:${id}:client:${m.id}`,
    });
    if (r.id) enqueued++; else skipped++;
  }
  await pool.query(`UPDATE campaigns SET status='done', done_at=NOW(), enqueued=$2, skipped=$3, updated_at=NOW() WHERE id=$1`, [id, enqueued, skipped]);
  return { audience: members.length, enqueued, skipped };
}

router.post('/:id/launch', requirePerm('promo.write'), async (req, res) => {
  try { res.json({ ok: true, ...(await launchCampaign(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Тестовая отправка себе перед массовой рассылкой
router.post('/:id/test', requirePerm('promo.write'), async (req, res) => {
  try {
    const c = (await getPool().query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'not-found' });
    const chat = req.body?.chat_id || process.env.ADMIN_TG_CHAT;
    if (!chat) return res.status(400).json({ error: 'no-test-recipient' });
    const r = await hub.enqueue({
      recipient: String(chat), channel: 'telegram',
      templateKey: c.template_key || undefined, body: c.template_key ? undefined : c.body,
      vars: { client: 'Тест', ...(c.vars || {}) }, priority: 'high', category: 'transactional',
      source: 'campaign-test', dedupKey: `camptest:${req.params.id}:${Date.now()}`,
    });
    if (r.id) await hub.processQueue(3);
    res.json({ ok: !r.skipped, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.launchCampaign = launchCampaign;
