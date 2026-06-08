/* ═══════════════════════════════════════════════════════
   SVS Beauty — Повторные визиты

   Логика: считаем средний интервал между визитами клиента.
   Когда прошло >= средний интервал с последнего визита →
   отправляем "пора записатися".

   Cron: раз в день (утром в 10:00 Kyiv).
   Дедупликация: scheduled_notifications.event = 'repeat_visit'

   Подключается как /api/repeat-visits
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { tgSend } = require('./telegram-notify');
const { requirePerm } = require('../lib/rbac');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_VISITS = 2;          // минимум 2 визита чтобы считать интервал
const MIN_INTERVAL_DAYS = 7;   // не предлагать чаще чем раз в неделю
const MAX_INTERVAL_DAYS = 180; // не предлагать если >6 мес (скорее всего ушёл)

// ── Найти клиентов которым пора записаться ──
async function findDueClients() {
  const pool = getPool();

  // Средний интервал между визитами для каждого клиента с telegram_id
  const r = await pool.query(`
    WITH visit_intervals AS (
      SELECT
        client_id,
        starts_at,
        LAG(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at) AS prev_visit,
        starts_at - LAG(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at) AS gap
      FROM appointments
      WHERE status IN ('completed', 'confirmed')
    ),
    client_stats AS (
      SELECT
        client_id,
        COUNT(*) AS visit_count,
        AVG(EXTRACT(EPOCH FROM gap) / 86400)::int AS avg_interval_days,
        MAX(starts_at) AS last_visit
      FROM visit_intervals
      WHERE gap IS NOT NULL
      GROUP BY client_id
      HAVING COUNT(*) >= $1
    )
    SELECT
      cs.client_id,
      cs.avg_interval_days,
      cs.last_visit,
      cs.visit_count,
      c.name AS client_name,
      c.telegram_id,
      c.phone,
      EXTRACT(EPOCH FROM (NOW() - cs.last_visit)) / 86400 AS days_since_last
    FROM client_stats cs
    JOIN clients c ON c.id = cs.client_id
    WHERE c.telegram_id IS NOT NULL
      AND cs.avg_interval_days BETWEEN $2 AND $3
      AND EXTRACT(EPOCH FROM (NOW() - cs.last_visit)) / 86400 >= cs.avg_interval_days
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_notifications sn
        WHERE sn.telegram_chat_id = c.telegram_id::text
          AND sn.event = 'repeat_visit'
          AND sn.scheduled_at > NOW() - interval '7 days'
      )
    ORDER BY days_since_last DESC
    LIMIT 50
  `, [MIN_VISITS, MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS]);

  return r.rows;
}

// ── Создать уведомления для клиентов ──
async function scheduleRepeatVisits() {
  const pool = getPool();
  const clients = await findDueClients();
  let scheduled = 0;

  for (const cl of clients) {
    const text = `👋 <b>${cl.client_name || 'Привіт'}!</b>\n\n` +
      `Минуло вже ${Math.round(cl.days_since_last)} днів з вашого останнього візиту. ` +
      `Зазвичай ви приходите кожні ~${cl.avg_interval_days} днів.\n\n` +
      `Час записатися? Напишіть нам або оберіть зручний час на сайті.`;

    try {
      await pool.query(
        `INSERT INTO scheduled_notifications
           (appointment_id, telegram_chat_id, client_phone, event, scheduled_at, payload_json, status)
         VALUES ($1, $2, $3, 'repeat_visit', NOW(), $4, 'pending')`,
        [
          `repeat_${cl.client_id}_${new Date().toISOString().slice(0, 10)}`,
          String(cl.telegram_id),
          cl.phone || null,
          JSON.stringify({ text, client_id: cl.client_id, avg_interval: cl.avg_interval_days })
        ]
      );
      scheduled++;
    } catch (e) {
      console.error(`[repeat-visits] insert for client ${cl.client_id}:`, e.message);
    }
  }

  return { scheduled, candidates: clients.length };
}

// ── API endpoints ──

// GET /api/repeat-visits/candidates — кому пора записаться
router.get('/candidates', async (req, res) => {
  try {
    const clients = await findDueClients();
    res.json({
      items: clients.map(c => ({
        client_id: c.client_id,
        name: c.client_name,
        visits: c.visit_count,
        avg_interval_days: c.avg_interval_days,
        days_since_last: Math.round(c.days_since_last),
        has_telegram: !!c.telegram_id,
      })),
      count: clients.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/repeat-visits/run — ручной запуск (только admin)
router.post('/run', requirePerm('reminders.manage'), async (req, res) => {
  try {
    const result = await scheduleRepeatVisits();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/repeat-visits/stats — статистика
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'repeat_visit' AND status = 'sent') AS sent,
        COUNT(*) FILTER (WHERE event = 'repeat_visit' AND status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE event = 'repeat_visit' AND scheduled_at > NOW() - interval '7 days') AS last_7d
      FROM scheduled_notifications
    `);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.scheduleRepeatVisits = scheduleRepeatVisits;
