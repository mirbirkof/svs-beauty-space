/* ═══════════════════════════════════════════════════════
   MKT-02 — Авто-триггеры маркетинга
   Подключается как /api/triggers

   Cron раз в сутки (по умолчанию 10:00 Киев) проходит включённые
   триггеры, находит подходящих клиентов и ставит им уведомления в
   Notification Hub (с дедупом + cooldown, чтобы не спамить).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const hub = require('../lib/notification-hub');

const TICK_INTERVAL = 60 * 60 * 1000; // проверяем каждый час, выполняем раз в сутки
let cronRef = null;

// SQL-выборки кандидатов по типу триггера. Возвращают client_id + name.
async function candidates(pool, trg) {
  const p = trg.params || {};
  if (trg.key === 'birthday') {
    const before = Number(p.days_before || 0);
    return pool.query(`
      SELECT id, name FROM clients
      WHERE deleted_at IS NULL AND birthday IS NOT NULL
        AND to_char(birthday,'MM-DD') = to_char(NOW() + ($1 || ' days')::interval, 'MM-DD')
    `, [String(before)]);
  }
  if (trg.key === 'reactivation') {
    const min = Number(p.days_inactive || 45), max = Number(p.days_max || 89);
    return pool.query(`
      SELECT id, name FROM clients
      WHERE deleted_at IS NULL AND last_visit_at IS NOT NULL
        AND last_visit_at <= NOW() - ($1 || ' days')::interval
        AND last_visit_at >  NOW() - ($2 || ' days')::interval
    `, [String(min), String(max + 1)]);
  }
  if (trg.key === 'winback') {
    const min = Number(p.days_inactive || 90);
    return pool.query(`
      SELECT id, name FROM clients
      WHERE deleted_at IS NULL AND last_visit_at IS NOT NULL
        AND last_visit_at <= NOW() - ($1 || ' days')::interval
    `, [String(min)]);
  }
  return { rows: [] };
}

// Запуск одного триггера: ставит уведомления в Hub
async function runTrigger(trg, { force = false } = {}) {
  const pool = getPool();
  const cand = await candidates(pool, trg);
  const today = new Date().toISOString().slice(0, 10);
  let enqueued = 0, skipped = 0;
  for (const c of cand.rows) {
    // cooldown: не слали ли этому клиенту по этому же триггеру за cooldown_days
    if (!force && trg.cooldown_days > 0) {
      const recent = await pool.query(
        `SELECT 1 FROM notifications
         WHERE client_id=$1 AND source=$2 AND created_at > NOW() - ($3 || ' days')::interval LIMIT 1`,
        [c.id, 'trigger:' + trg.key, String(trg.cooldown_days)]);
      if (recent.rowCount) { skipped++; continue; }
    }
    const r = await hub.enqueue({
      clientId: c.id,
      channel: trg.channel === 'any' ? undefined : trg.channel,
      templateKey: trg.template_key,
      vars: { client: c.name || '' },
      category: 'marketing', priority: 'low',
      source: 'trigger:' + trg.key,
      dedupKey: `trigger:${trg.key}:${c.id}:${today}`,
    });
    if (r.id) enqueued++; else skipped++;
  }
  await pool.query(`UPDATE marketing_triggers SET last_run_at=NOW(), last_enqueued=$2, updated_at=NOW() WHERE id=$1`, [trg.id, enqueued]);
  return { trigger: trg.key, candidates: cand.rows.length, enqueued, skipped };
}

// Cron-тик: раз в сутки прогоняет все включённые триггеры
let lastDailyRun = null;
async function dailyTick() {
  try {
    const hour = Number(new Intl.DateTimeFormat('uk-UA', { hour: 'numeric', hour12: false, timeZone: 'Europe/Kyiv' }).format(new Date()));
    const today = new Date().toISOString().slice(0, 10);
    if (hour < 10 || lastDailyRun === today) return; // только после 10:00 и раз в день
    lastDailyRun = today;
    const pool = getPool();
    const trgs = await pool.query(`SELECT * FROM marketing_triggers WHERE enabled=TRUE`);
    for (const trg of trgs.rows) {
      const res = await runTrigger(trg);
      if (res.enqueued) console.log(`[mkt-triggers] ${res.trigger}: enqueued=${res.enqueued} skipped=${res.skipped}`);
    }
  } catch (e) { console.error('[mkt-triggers] tick error:', e.message); }
}

// ── API ─────────────────────────────────────────────────────────────
router.get('/', requirePerm('promo.write'), async (req, res) => {
  try { res.json({ items: (await getPool().query(`SELECT * FROM marketing_triggers ORDER BY id`)).rows }); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const pool = getPool();
    const allowed = ['enabled', 'template_key', 'channel', 'params', 'cooldown_days', 'name'];
    const sets = [], args = [];
    for (const k of allowed) if (k in req.body) {
      args.push(k === 'params' ? JSON.stringify(req.body[k]) : req.body[k]); sets.push(`${k}=$${args.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    args.push(req.params.id);
    const r = await pool.query(`UPDATE marketing_triggers SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${args.length} RETURNING *`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, trigger: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Ручной прогон (для теста) — без cooldown по запросу force=true
router.post('/:id/run', requirePerm('promo.write'), async (req, res) => {
  try {
    const trg = (await getPool().query(`SELECT * FROM marketing_triggers WHERE id=$1`, [req.params.id])).rows[0];
    if (!trg) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, ...(await runTrigger(trg, { force: !!req.body?.force })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Предпросмотр: сколько кандидатов сейчас под триггер (без отправки)
router.get('/:id/preview', requirePerm('promo.write'), async (req, res) => {
  try {
    const trg = (await getPool().query(`SELECT * FROM marketing_triggers WHERE id=$1`, [req.params.id])).rows[0];
    if (!trg) return res.status(404).json({ error: 'not-found' });
    const cand = await candidates(getPool(), trg);
    res.json({ ok: true, candidates: cand.rows.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function startCron() {
  if (cronRef) return;
  dailyTick();
  cronRef = setInterval(dailyTick, TICK_INTERVAL);
  console.log('[mkt-triggers] cron started (hourly check, daily run after 10:00)');
}
function stopCron() { if (cronRef) { clearInterval(cronRef); cronRef = null; } }

module.exports = router;
module.exports.startCron = startCron;
module.exports.stopCron = stopCron;
module.exports.runTrigger = runTrigger;
