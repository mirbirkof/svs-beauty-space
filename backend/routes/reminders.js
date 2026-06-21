/* ═══════════════════════════════════════════════════════
   SVS Beauty — Авто-напоминания о визитах

   Cron (setInterval 15 мин):
   1. За 24ч до визита → "Нагадуємо: завтра о HH:MM у майстра X"
   2. За 2ч до визита  → "Через 2 години ваш візит о HH:MM"
   3. Через 2ч после   → "Як вам візит? Оцініть від 1 до 5"

   Использует scheduled_notifications для дедупликации.
   Отправка через tgSend из telegram-notify.

   Подключается как /api/reminders
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { tgSend } = require('./telegram-notify');
const { requirePerm } = require('../lib/rbac');
const hub = require('../lib/notification-hub');

const CRON_INTERVAL = 15 * 60 * 1000; // 15 мин
let cronRef = null;

// ── Генерация уведомлений для предстоящих визитов (через Notification Hub) ──
// Дедуп — на стороне Hub (dedup_key = appt:{id}:{event}, ON CONFLICT DO NOTHING).
// Шаблоны — из БД (appt_remind_24h / appt_remind_2h / appt_feedback).
function kyivTime(ts) {
  return new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
}

async function scheduleReminders() {
  const pool = getPool();

  // 1) За 24ч: визиты через 23-25 часов → normal
  const in24h = await pool.query(`
    SELECT a.id, a.starts_at, a.client_id,
           m.name AS master_name, s.name AS service_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status IN ('confirmed', 'pending', 'booked')
      AND a.starts_at BETWEEN NOW() + interval '23 hours' AND NOW() + interval '25 hours'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedup_key = 'appt:' || a.id || ':remind_24h')
  `);
  for (const row of in24h.rows) {
    await hub.enqueue({
      clientId: row.client_id, templateKey: 'appt_remind_24h', priority: 'normal',
      category: 'transactional', source: 'reminders', dedupKey: `appt:${row.id}:remind_24h`,
      vars: { time: kyivTime(row.starts_at), master: row.master_name || '', service: row.service_name || '' },
    });
  }

  // 2) За 2ч: визиты через 1.5-2.5 часа → high
  const in2h = await pool.query(`
    SELECT a.id, a.starts_at, a.client_id, m.name AS master_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    WHERE a.status IN ('confirmed', 'pending', 'booked')
      AND a.starts_at BETWEEN NOW() + interval '90 minutes' AND NOW() + interval '150 minutes'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedup_key = 'appt:' || a.id || ':remind_2h')
  `);
  for (const row of in2h.rows) {
    await hub.enqueue({
      clientId: row.client_id, templateKey: 'appt_remind_2h', priority: 'high',
      category: 'transactional', source: 'reminders', dedupKey: `appt:${row.id}:remind_2h`,
      vars: { time: kyivTime(row.starts_at), master: row.master_name || '' },
    });
  }

  // 3) После визита (2ч назад): запрос оценки → low
  const after2h = await pool.query(`
    SELECT a.id, a.starts_at, a.client_id, c.name AS client_name, m.name AS master_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    WHERE a.status = 'done'
      AND COALESCE(a.ends_at, a.starts_at + interval '1 hour') BETWEEN NOW() - interval '150 minutes' AND NOW() - interval '90 minutes'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedup_key = 'appt:' || a.id || ':feedback')
  `);
  for (const row of after2h.rows) {
    await hub.enqueue({
      clientId: row.client_id, templateKey: 'appt_feedback', priority: 'low',
      category: 'transactional', source: 'reminders', dedupKey: `appt:${row.id}:feedback`,
      vars: { client: row.client_name || 'Привіт', master: row.master_name || '' },
    });
  }

  return { remind_24h: in24h.rowCount, remind_2h: in2h.rowCount, feedback: after2h.rowCount };
}

// ── Отправка pending уведомлений ──
async function sendPending() {
  const pool = getPool();

  // Запись отменили после планирования напоминания → не слать
  await pool.query(`
    UPDATE scheduled_notifications sn SET status = 'cancelled'
    WHERE sn.status = 'pending'
      AND sn.event IN ('remind_24h', 'remind_2h')
      AND EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.id::text = sn.appointment_id
          AND a.status NOT IN ('confirmed', 'pending', 'booked', 'done')
      )
  `);

  const pending = await pool.query(
    `SELECT id, telegram_chat_id, payload_json, event, attempts
     FROM scheduled_notifications
     WHERE status = 'pending' AND attempts < 3
     ORDER BY scheduled_at
     LIMIT 20`
  );

  let sent = 0, failed = 0;
  for (const n of pending.rows) {
    try {
      const payload = JSON.parse(n.payload_json);
      await tgSend(n.telegram_chat_id, payload.text);
      await pool.query(
        `UPDATE scheduled_notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [n.id]
      );
      sent++;
    } catch (e) {
      await pool.query(
        `UPDATE scheduled_notifications SET attempts = attempts + 1, last_error = $1 WHERE id = $2`,
        [e.message, n.id]
      );
      failed++;
    }
  }

  return { sent, failed, total: pending.rowCount };
}

// ── Cron tick ──
async function cronTick() {
  try {
    const scheduled = await scheduleReminders();
    const delivery = await sendPending();
    const total = scheduled.remind_24h + scheduled.remind_2h + scheduled.feedback;
    if (total > 0 || delivery.sent > 0) {
      console.log(`[reminders] scheduled=${JSON.stringify(scheduled)} sent=${delivery.sent} failed=${delivery.failed}`);
    }
  } catch (e) {
    console.error('[reminders] cron error:', e.message);
  }
}

// ── API endpoints ──

// GET /api/reminders/status — статистика (из Notification Hub)
router.get('/status', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`
      SELECT
        count(*) FILTER (WHERE status IN ('queued','sending'))                              AS scheduled,
        count(*) FILTER (WHERE status IN ('sent','delivered') AND sent_at::date = CURRENT_DATE) AS sent_today,
        count(*) FILTER (WHERE status = 'failed')                                           AS failed
      FROM notifications
      WHERE source = 'reminders'
    `);
    const row = r.rows[0] || {};
    const stats = {
      scheduled: Number(row.scheduled) || 0,
      sent_today: Number(row.sent_today) || 0,
      failed: Number(row.failed) || 0,
    };
    // cron_active (новое имя) + cron_enabled (legacy для совместимости фронта)
    res.json({ ok: true, cron_active: !!cronRef, cron_enabled: !!cronRef, stats });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/reminders/run — ручной запуск (для теста, только admin)
router.post('/run', requirePerm('reminders.manage'), async (req, res) => {
  try {
    const scheduled = await scheduleReminders();
    const delivery = await sendPending();
    res.json({ ok: true, scheduled, delivery });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/reminders/pending — список запланированных (из Notification Hub)
router.get('/pending', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const r = await pool.query(
      `SELECT n.id, n.template_key AS type, n.channel, n.status,
              n.scheduled_at, n.attempts,
              c.name AS client_name, c.phone AS client_phone
       FROM notifications n
       LEFT JOIN clients c ON c.id = n.client_id
       WHERE n.source = 'reminders' AND n.status IN ('queued','sending')
       ORDER BY n.scheduled_at
       LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Start/stop cron ──
function startCron() {
  if (cronRef) return;
  cronTick(); // first run immediately
  cronRef = setInterval(cronTick, CRON_INTERVAL);
  console.log('[reminders] cron started (every 15 min)');
}

function stopCron() {
  if (cronRef) { clearInterval(cronRef); cronRef = null; }
}

module.exports = router;
module.exports.startCron = startCron;
module.exports.stopCron = stopCron;
