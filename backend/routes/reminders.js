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

const CRON_INTERVAL = 15 * 60 * 1000; // 15 мин
let cronRef = null;

// ── Генерация уведомлений для предстоящих визитов ──
async function scheduleReminders() {
  const pool = getPool();
  const now = new Date();

  // 1) За 24ч: визиты через 23-25 часов
  const in24h = await pool.query(`
    SELECT a.id, a.starts_at, a.client_id, a.master_id,
           c.telegram_id, c.name AS client_name, c.phone,
           m.name AS master_name,
           s.name AS service_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status IN ('confirmed', 'pending')
      AND a.starts_at BETWEEN NOW() + interval '23 hours' AND NOW() + interval '25 hours'
      AND c.telegram_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_notifications sn
        WHERE sn.appointment_id = a.id::text AND sn.event = 'remind_24h'
      )
  `);

  for (const row of in24h.rows) {
    const time = new Date(row.starts_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
    const text = `📋 <b>Нагадування</b>\nЗавтра о ${time} у вас запис` +
      (row.master_name ? ` до майстра <b>${row.master_name}</b>` : '') +
      (row.service_name ? ` (${row.service_name})` : '') +
      `.\n\nЯкщо потрібно перенести — напишіть нам.`;

    await insertNotification(pool, row, 'remind_24h', text, row.starts_at);
  }

  // 2) За 2ч: визиты через 1.5-2.5 часа
  const in2h = await pool.query(`
    SELECT a.id, a.starts_at, a.client_id, a.master_id,
           c.telegram_id, c.name AS client_name, c.phone,
           m.name AS master_name,
           s.name AS service_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status IN ('confirmed', 'pending')
      AND a.starts_at BETWEEN NOW() + interval '90 minutes' AND NOW() + interval '150 minutes'
      AND c.telegram_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_notifications sn
        WHERE sn.appointment_id = a.id::text AND sn.event = 'remind_2h'
      )
  `);

  for (const row of in2h.rows) {
    const time = new Date(row.starts_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
    const text = `⏰ Через 2 години ваш візит о <b>${time}</b>` +
      (row.master_name ? ` у <b>${row.master_name}</b>` : '') +
      `. Чекаємо на вас!`;

    await insertNotification(pool, row, 'remind_2h', text, row.starts_at);
  }

  // 3) После визита (2ч назад): запрос оценки
  const after2h = await pool.query(`
    SELECT a.id, a.starts_at, a.ends_at, a.client_id,
           c.telegram_id, c.name AS client_name,
           m.name AS master_name,
           s.name AS service_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN masters m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status = 'completed'
      AND COALESCE(a.ends_at, a.starts_at + interval '1 hour') BETWEEN NOW() - interval '150 minutes' AND NOW() - interval '90 minutes'
      AND c.telegram_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_notifications sn
        WHERE sn.appointment_id = a.id::text AND sn.event = 'feedback'
      )
  `);

  for (const row of after2h.rows) {
    const text = `💬 <b>${row.client_name || 'Привіт'}!</b>\nЯк вам сьогоднішній візит` +
      (row.master_name ? ` у <b>${row.master_name}</b>` : '') +
      `?\n\nОцініть від 1 до 5:\n1 ⭐ — погано\n3 ⭐⭐⭐ — нормально\n5 ⭐⭐⭐⭐⭐ — чудово`;

    await insertNotification(pool, row, 'feedback', text, row.starts_at);
  }

  return { remind_24h: in24h.rowCount, remind_2h: in2h.rowCount, feedback: after2h.rowCount };
}

async function insertNotification(pool, row, event, text, appointmentTime) {
  try {
    await pool.query(
      `INSERT INTO scheduled_notifications
         (appointment_id, telegram_chat_id, client_phone, event, scheduled_at, payload_json, status)
       VALUES ($1, $2, $3, $4, NOW(), $5, 'pending')`,
      [String(row.id), String(row.telegram_id), row.phone || null, event, JSON.stringify({ text })]
    );
  } catch (e) {
    console.error(`[reminders] insert ${event} for appt ${row.id}:`, e.message);
  }
}

// ── Отправка pending уведомлений ──
async function sendPending() {
  const pool = getPool();
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

// GET /api/reminders/status — статистика
router.get('/status', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`
      SELECT status, count(*)::int AS cnt
      FROM scheduled_notifications
      GROUP BY status
    `);
    const stats = {};
    r.rows.forEach(row => stats[row.status] = row.cnt);
    res.json({ ok: true, cron_active: !!cronRef, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reminders/run — ручной запуск (для теста)
router.post('/run', async (req, res) => {
  try {
    const scheduled = await scheduleReminders();
    const delivery = await sendPending();
    res.json({ ok: true, scheduled, delivery });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reminders/pending — список pending
router.get('/pending', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, appointment_id, event, telegram_chat_id, scheduled_at, attempts
       FROM scheduled_notifications
       WHERE status = 'pending'
       ORDER BY scheduled_at
       LIMIT 50`
    );
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
