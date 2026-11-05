/* ═══════════════════════════════════════════════════════
   SVS Beauty — Повторні візити (нотатка #175, переписано 05.11)

   Що це: клієнти, яким ЗА ЇХНІМ ВЛАСНИМ РИТМОМ пора прийти знову.
   Ритм = середній проміжок між днями виконаних візитів клієнта (мінімум 3 візити,
   ритм 7..180 днів). Клієнт «пора записатись», коли з останнього візиту минуло
   не менше за його ритм і в нього НЕМАЄ майбутнього запису.

   Чим відрізняється від «Повернення клієнтів» на дашборді: там — давно втрачені
   (поріг днів / норма послуги), тут — постійні клієнти, яких ще можна повернути
   вчасно (за замовчуванням прострочка не більше 3 їхніх інтервалів).

   Чому переписано: раніше список брав ЛИШЕ клієнтів з Telegram (3 з 5545) → завжди
   порожньо; поля відповіді не збігались з тим, що малює адмінка (усюди «—»);
   статистика віддавала інші ключі; кампанію ніхто не запускав за розкладом.

   «Останній візит» = максимум з двох джерел (як у віджеті повернення на дашборді):
   жива історія записів (done) і знімок clients.last_visit_at.

   Нагадування (єдине джерело для статистики «нагадали → повернулись»):
     1) задача «… пора на повторний візит» на дошці задач (кнопка «Нагадати» —
        і тут, і у віджеті дашборду створюють ОДНАКОВУ задачу);
     2) Telegram-повідомлення scheduled_notifications.event='repeat_visit'
        (кнопка «Надіслати в Telegram»; доставляє крон нагадувань раз на 15 хв).

   Підключається як /api/repeat-visits
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const MIN_GAPS = 2;            // ≥2 проміжки = ≥3 дні візитів, інакше «ритму» ще немає
const MIN_INTERVAL_DAYS = 7;   // не пропонувати частіше ніж раз на тиждень
const MAX_INTERVAL_DAYS = 180; // ритм >6 міс — це не «повторний візит»
const FRESH_MULT = 3;          // «вчасно повернути» = прострочка ≤ 3 власних інтервалів
const REMINDER_TASK_MARK = 'пора на повторний візит'; // той самий текст, що й у віджеті дашборду

// ── Кандидати ──
// scope: 'fresh' (за замовчуванням) — прострочка ≤ FRESH_MULT інтервалів; 'all' — усі прострочені.
async function findDueClients({ scope = 'fresh', onlyTelegram = false, limit = 500 } = {}) {
  const pool = getPool();
  const r = await pool.query(`
    WITH visit_days AS (
      -- Візит = унікальний день (кілька послуг в один день — один візит).
      SELECT DISTINCT client_id, (starts_at AT TIME ZONE 'Europe/Kyiv')::date AS vday
        FROM appointments
       WHERE status = 'done' AND starts_at <= NOW() AND client_id IS NOT NULL
    ),
    gaps AS (
      SELECT client_id, vday, vday - LAG(vday) OVER (PARTITION BY client_id ORDER BY vday) AS gap
        FROM visit_days
    ),
    cs AS (
      SELECT client_id, COUNT(*) + 1 AS visit_days, ROUND(AVG(gap))::int AS avg_interval_days,
             MAX(vday) AS last_done
        FROM gaps WHERE gap IS NOT NULL
       GROUP BY client_id
      HAVING COUNT(*) >= $1
    ),
    base AS (
      SELECT cs.client_id, cs.visit_days, cs.avg_interval_days,
             GREATEST(cs.last_done, COALESCE(c.last_visit_at::date, cs.last_done)) AS last_visit,
             (CURRENT_DATE - GREATEST(cs.last_done, COALESCE(c.last_visit_at::date, cs.last_done)))::int AS days_since,
             c.name, c.phone, c.telegram_id, COALESCE(c.total_spent, 0) AS total_spent
        FROM cs JOIN clients c ON c.id = cs.client_id
       WHERE cs.avg_interval_days BETWEEN $2 AND $3
    )
    SELECT b.*,
           b.days_since - b.avg_interval_days AS overdue_days,
           ls.last_service, ls.last_master,
           rm.last_reminded_at
      FROM base b
      LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(a.services_text, ''), s.name) AS last_service, m.name AS last_master
          FROM appointments a
          LEFT JOIN services s ON s.id = a.service_id
          LEFT JOIN masters m ON m.id = a.master_id
         WHERE a.client_id = b.client_id AND a.status = 'done' AND a.starts_at <= NOW()
         ORDER BY a.starts_at DESC LIMIT 1
      ) ls ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(x) AS last_reminded_at FROM (
          SELECT MAX(t.created_at) AS x FROM tasks t
           WHERE t.client_id = b.client_id AND t.title LIKE '%' || $5 || '%'
          UNION ALL
          SELECT MAX(sn.created_at) FROM scheduled_notifications sn
           WHERE sn.event = 'repeat_visit' AND sn.payload_json::jsonb ->> 'client_id' = b.client_id::text
        ) u
      ) rm ON TRUE
     WHERE b.days_since >= b.avg_interval_days
       AND ($4::boolean = FALSE OR b.days_since <= b.avg_interval_days * ${FRESH_MULT})
       AND ($6::boolean = FALSE OR b.telegram_id IS NOT NULL)
       -- вже записаний наперед → нагадувати нема про що
       AND NOT EXISTS (
         SELECT 1 FROM appointments f
          WHERE f.client_id = b.client_id AND f.starts_at > NOW()
            AND f.status NOT IN ('cancelled', 'noshow', 'done')
       )
     ORDER BY (b.days_since::float / NULLIF(b.avg_interval_days, 0)) ASC, b.total_spent DESC
     LIMIT $7
  `, [MIN_GAPS, MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS, scope !== 'all', REMINDER_TASK_MARK, !!onlyTelegram, limit]);
  return r.rows;
}

// ── Telegram-розсилка: ставимо в чергу scheduled_notifications (доставляє крон нагадувань) ──
async function scheduleRepeatVisits() {
  const pool = getPool();
  const clients = await findDueClients({ scope: 'fresh', onlyTelegram: true, limit: 200 });
  let scheduled = 0, skipped = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const cl of clients) {
    // дедуп: не частіше ніж раз на 7 днів одному клієнту (будь-яке нагадування)
    if (cl.last_reminded_at && Date.now() - new Date(cl.last_reminded_at).getTime() < 7 * 86400000) { skipped++; continue; }
    const text = `👋 <b>${cl.name || 'Привіт'}!</b>\n\n` +
      `Минуло вже ${cl.days_since} днів з вашого останнього візиту. ` +
      `Зазвичай ви приходите кожні ~${cl.avg_interval_days} днів.\n\n` +
      `Час записатися? Напишіть нам або оберіть зручний час на сайті.`;
    try {
      const ins = await pool.query(
        `INSERT INTO scheduled_notifications
           (appointment_id, telegram_chat_id, client_phone, event, scheduled_at, payload_json, status)
         SELECT $1::text, $2::text, $3::text, 'repeat_visit', NOW(), $4::text, 'pending'
          WHERE NOT EXISTS (SELECT 1 FROM scheduled_notifications WHERE appointment_id = $1::text AND event = 'repeat_visit')`,
        [`repeat_${cl.client_id}_${today}`, String(cl.telegram_id), cl.phone || null,
         JSON.stringify({ text, client_id: cl.client_id, avg_interval: cl.avg_interval_days })]
      );
      if (ins.rowCount) scheduled++; else skipped++;
    } catch (e) {
      console.error(`[repeat-visits] insert for client ${cl.client_id}:`, e.message);
    }
  }
  return { scheduled, skipped, candidates: clients.length };
}

// ── API ──

// GET /api/repeat-visits/candidates?scope=fresh|all&limit=
router.get('/candidates', requirePerm('clients.read'), async (req, res) => {
  try {
    const scope = req.query.scope === 'all' ? 'all' : 'fresh';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const rows = await findDueClients({ scope, limit });
    res.json({
      scope,
      items: rows.map(c => ({
        client_id: c.client_id,
        name: c.name,
        phone: c.phone,
        visits: Number(c.visit_days),
        avg_interval_days: c.avg_interval_days,
        last_visit: c.last_visit,
        days_since: c.days_since,
        overdue_days: c.overdue_days,
        last_service: c.last_service,
        last_master: c.last_master,
        total_spent: Math.round(Number(c.total_spent || 0)),
        has_telegram: !!c.telegram_id,
        last_reminded_at: c.last_reminded_at,
      })),
      count: rows.length,
    });
  } catch (e) { console.error('[repeat-visits:candidates]', e.message); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/repeat-visits/run — Telegram-нагадування всім кандидатам з Telegram
router.post('/run', requirePerm('reminders.manage'), async (req, res) => {
  try {
    const result = await scheduleRepeatVisits();
    res.json({ ok: true, ...result });
  } catch (e) { console.error('[repeat-visits:run]', e.message); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /api/repeat-visits/stats — кандидати + «нагадали → повернулись» за 90 днів
router.get('/stats', requirePerm('clients.read'), async (req, res) => {
  try {
    const pool = getPool();
    const [fresh, all] = await Promise.all([
      findDueClients({ scope: 'fresh', limit: 1000 }),
      findDueClients({ scope: 'all', limit: 1000 }),
    ]);
    const r = await pool.query(`
      WITH rem AS (
        SELECT client_id, MIN(at) AS first_at FROM (
          SELECT t.client_id, t.created_at AS at FROM tasks t
           WHERE t.client_id IS NOT NULL AND t.title LIKE '%' || $1 || '%'
             AND t.created_at > NOW() - interval '90 days'
          UNION ALL
          SELECT (sn.payload_json::jsonb ->> 'client_id')::int, COALESCE(sn.sent_at, sn.created_at)
            FROM scheduled_notifications sn
           WHERE sn.event = 'repeat_visit' AND sn.status = 'sent'
             AND sn.created_at > NOW() - interval '90 days'
        ) u WHERE client_id IS NOT NULL GROUP BY client_id
      ),
      back AS (
        SELECT rem.client_id,
               COUNT(a.id) AS appts,
               COALESCE(SUM(a.price) FILTER (WHERE a.status = 'done'), 0) AS revenue
          FROM rem
          JOIN appointments a ON a.client_id = rem.client_id
           AND a.created_at > rem.first_at
           AND a.status NOT IN ('cancelled', 'noshow')
         GROUP BY rem.client_id
      )
      SELECT (SELECT COUNT(*) FROM rem) AS reminded,
             (SELECT COUNT(*) FROM back) AS returned,
             (SELECT COALESCE(SUM(revenue), 0) FROM back) AS revenue_back,
             (SELECT COUNT(*) FROM scheduled_notifications WHERE event = 'repeat_visit' AND status = 'pending') AS tg_pending
    `, [REMINDER_TASK_MARK]);
    const s = r.rows[0] || {};
    const reminded = Number(s.reminded || 0), returned = Number(s.returned || 0);
    res.json({ ok: true, stats: {
      candidates: fresh.length,
      candidates_all: all.length,
      with_telegram: fresh.filter(x => x.telegram_id).length,
      reminded_90d: reminded,
      returned_90d: returned,
      conversion: reminded ? Math.round(returned / reminded * 100) : 0,
      revenue_back: Math.round(Number(s.revenue_back || 0)),
      tg_pending: Number(s.tg_pending || 0),
    } });
  } catch (e) { console.error('[repeat-visits:stats]', e.message); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
module.exports.scheduleRepeatVisits = scheduleRepeatVisits;
module.exports.findDueClients = findDueClients;
