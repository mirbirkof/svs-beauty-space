/* Кабінет майстра — /api/me/*
   Власник хоче: майстер бачить ТІЛЬКИ свій графік / своїх клієнтів / свою
   зарплату / свої послуги. Жодного доступу до хазяйських розділів CRM.

   Усі ендпоінти:
     • потребують лише авторизації (requirePerm());
     • жорстко фільтрують дані по ВЛАСНОМУ req.user.master_id;
     • доступні тільки ролі 'master' (інші ролі мають свої повноцінні розділи).

   Графік   → /api/schedule/journal  (вже фільтрує по своєму master_id)
   Зарплата → /api/payroll/my        (вже фільтрує по своєму master_id)
   Клієнти  → GET /api/me/clients     (тут)
   Послуги  → GET /api/me/services    (тут)
   Профіль  → GET /api/me/profile     (тут)
*/
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { maskPhone, shouldMaskPhones, getSetting } = require('../lib/settings');
const router = express.Router();
const pool = getPool();

// Салон (за замовчуванням) vs майстер-одиночка. У салоні клієнти належать салону,
// тож найманий майстер НЕ бачить розділ «Клієнти» (це для соло-майстрів, що ведуть свою базу).
// Вмикається налаштуванням solo_master_mode=true (окремий tenant-одиночка).
async function isSoloMaster() { return String(await getSetting('solo_master_mode', false)) === 'true'; }

// Тільки авторизований майстер зі своїм master_id.
router.use(requirePerm());
router.use((req, res, next) => {
  if (req.user && req.user.role === 'master' && req.user.master_id) {
    req.mid = Number(req.user.master_id);
    return next();
  }
  return res.status(403).json({ error: 'forbidden', message: 'Тільки для майстра' });
});

// ── Профіль майстра ───────────────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.name, m.surname, m.phone, m.avatar, m.specialty, m.active
         FROM masters m WHERE m.id = $1`, [req.mid]);
    res.json({ ok: true, master: r.rows[0] || null, solo: await isSoloMaster() });
  } catch (e) { console.error('me/profile', e); res.status(500).json({ error: 'internal' }); }
});

// ── Мої клієнти ───────────────────────────────────────────
// Унікальні клієнти, що були в цього майстра. Сума — по фактично сплаченому
// (COALESCE(real_amount, price)), а не плановій ціні.
router.get('/clients', async (req, res) => {
  try {
    // у салоні клієнти належать салону — найманий майстер не бачить базу (тільки соло-майстер)
    if (!(await isSoloMaster())) return res.json({ ok: true, items: [], count: 0, disabled: true, reason: 'salon-clients-belong-to-salon' });
    const r = await pool.query(
      `SELECT
          COALESCE(c.id, 0)                                      AS client_id,
          COALESCE(c.name, a.client_name, 'Без імені')           AS name,
          c.phone,
          COUNT(*) FILTER (WHERE a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))::int AS visits,
          MAX(a.starts_at)                                        AS last_visit,
          COALESCE(SUM(
            CASE WHEN a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL)
                 THEN COALESCE(a.real_amount, a.price) ELSE 0 END
          ), 0)::numeric                                          AS spent
        FROM appointments a
        LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.master_id = $1
       GROUP BY COALESCE(c.id, 0), COALESCE(c.name, a.client_name, 'Без імені'), c.phone
       ORDER BY last_visit DESC NULLS LAST
       LIMIT 500`, [req.mid]);
    let items = r.rows;
    if (await shouldMaskPhones(req.user)) {
      items = items.map(c => ({ ...c, phone: maskPhone(c.phone), phone_hidden: true }));
    }
    res.json({ ok: true, items, count: items.length });
  } catch (e) { console.error('me/clients', e); res.status(500).json({ error: 'internal' }); }
});

// ── Мої послуги ───────────────────────────────────────────
// Послуги, які майстер надає: з прайсу майстра (service_master_prices +
// master_services). Якщо прайс порожній — fallback на фактично надані послуги
// з записів. Ціна — індивідуальна ціна майстра, інакше базова.
router.get('/services', async (req, res) => {
  try {
    const r = await pool.query(
      `WITH price_list AS (
          SELECT service_id, MAX(price) AS price, MAX(duration_min) AS duration_min
            FROM service_master_prices
           WHERE master_id = $1 AND COALESCE(active, true) = true
           GROUP BY service_id
          UNION
          SELECT service_id, MAX(price) AS price, MAX(duration_min) AS duration_min
            FROM master_services
           WHERE master_id = $1 AND COALESCE(active, true) = true
           GROUP BY service_id
       ),
       from_appts AS (
          SELECT DISTINCT service_id
            FROM appointments
           WHERE master_id = $1 AND service_id IS NOT NULL
       ),
       ids AS (
          SELECT service_id FROM price_list
          UNION
          SELECT service_id FROM from_appts
       )
       SELECT s.id,
              COALESCE(s.name_ua, s.name)                 AS name,
              s.category,
              COALESCE(pl.price, s.price)                 AS price,
              COALESCE(pl.duration_min, s.duration_min)   AS duration_min
         FROM ids
         JOIN services s ON s.id = ids.service_id
         LEFT JOIN price_list pl ON pl.service_id = ids.service_id
        WHERE COALESCE(s.deleted_at, NULL) IS NULL
        ORDER BY s.category NULLS LAST, name`, [req.mid]);
    res.json({ ok: true, items: r.rows, count: r.rows.length });
  } catch (e) { console.error('me/services', e); res.status(500).json({ error: 'internal' }); }
});

// ── Мій графік ────────────────────────────────────────────
// Записи майстра: сьогодні + майбутні (за замовч. горизонт 30 днів),
// або за конкретну дату ?date=YYYY-MM-DD. Сума — по фактично сплаченому.
router.get('/schedule', async (req, res) => {
  try {
    const date = (req.query.date || '').trim();
    const params = [req.mid];
    let where = `a.master_id = $1`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      params.push(date);
      where += ` AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date`;
    } else {
      // сьогодні і вперед на 30 днів
      where += ` AND a.starts_at >= (now() AT TIME ZONE 'Europe/Kyiv')::date
                 AND a.starts_at <  ((now() AT TIME ZONE 'Europe/Kyiv')::date + INTERVAL '31 days')`;
    }
    const r = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status,
              COALESCE(s.name_ua, s.name, a.services_text) AS service,
              COALESCE(c.name, a.client_name, 'Клієнт')    AS client,
              COALESCE(a.real_amount, a.price)             AS amount
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN clients  c ON c.id = a.client_id
        WHERE ${where}
        ORDER BY a.starts_at ASC
        LIMIT 500`, params);
    res.json({ ok: true, items: r.rows, count: r.rows.length });
  } catch (e) { console.error('me/schedule', e); res.status(500).json({ error: 'internal' }); }
});

// ── Місячний графік: робочі дні / вихідні ─────────────────
// Майстер бачить свій місяць: які дні робочі (з годинами) і які вихідні.
// Джерело — master_schedule_days (start_time IS NULL = вихідний цього дня).
router.get('/month-schedule', async (req, res) => {
  try {
    const m = (req.query.month || '').trim();
    const month = /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
    const first = `${month}-01`;
    const r = await pool.query(
      `SELECT to_char(work_date,'YYYY-MM-DD')      AS date,
              to_char(start_time,'HH24:MI')        AS start,
              to_char(end_time,'HH24:MI')          AS "end",
              (start_time IS NOT NULL)             AS working
         FROM master_schedule_days
        WHERE master_id = $1
          AND work_date >= $2::date
          AND work_date <  ($2::date + INTERVAL '1 month')
        ORDER BY work_date`, [req.mid, first]);
    const days = {};
    for (const row of r.rows) days[row.date] = { working: row.working, start: row.start, end: row.end };
    const workCount = r.rows.filter(x => x.working).length;
    const offCount = r.rows.filter(x => !x.working).length;
    res.json({ ok: true, month, days, work_days: workCount, days_off: offCount, has_data: r.rows.length > 0 });
  } catch (e) { console.error('me/month-schedule', e); res.status(500).json({ error: 'internal' }); }
});

// ── Статистика майстра (мініапп «Я майстер», Босс 03.11) ──────────────
// Заробіток і виручка — ТА САМА функція, що «Зарплатна відомість» (payouts.liveEstimate,
// формули lib/payroll-base), тому цифри збігаються з /api/payouts/sheet. Лише читання.
// master_id з запиту ігнорується — завжди свій (req.mid).
const KYIV = `(now() AT TIME ZONE 'Europe/Kyiv')`;
router.get('/stats', async (req, res) => {
  try {
    const mq = String(req.query.month || '').trim();
    const cur = (await pool.query(`SELECT to_char(${KYIV},'YYYY-MM') AS m`)).rows[0].m;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(mq) ? mq : cur;
    const from = `${month}-01`;
    const next = (await pool.query(`SELECT to_char($1::date + INTERVAL '1 month','YYYY-MM-DD') AS d`, [from])).rows[0].d;
    const mid = req.mid;

    const upcoming = (await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = ${KYIV}::date)::int AS today,
         COUNT(*) FILTER (WHERE (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = ${KYIV}::date + 1)::int AS tomorrow,
         COUNT(*)::int AS week
         FROM appointments a
        WHERE a.master_id=$1 AND COALESCE(a.status,'') NOT IN ('cancelled','noshow','no_show')
          AND a.starts_at >= ${KYIV}::date AT TIME ZONE 'Europe/Kyiv'
          AND a.starts_at <  (${KYIV}::date + 7) AT TIME ZONE 'Europe/Kyiv'`, [mid])).rows[0];

    const est = await require('./payouts').liveEstimate(mid, from, next);

    // Візити/клієнти/чек — той самий фільтр «відбувся», що й у відомості.
    const v = (await pool.query(
      `WITH vis AS (
         SELECT a.id, a.client_id, COALESCE(a.real_amount,a.price,0)::numeric AS amt,
                (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date AS d
           FROM appointments a
          WHERE a.master_id=$1
            AND a.starts_at >= ($2||' 00:00:00+03')::timestamptz AND a.starts_at < ($3||' 00:00:00+03')::timestamptz
            AND a.starts_at <= NOW()
            AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL)))
       -- візит = клієнт + день (як у звіті майстрів, аудит 25.07): три послуги за один прихід — один візит
       SELECT COUNT(DISTINCT (COALESCE(client_id::text, 'anon-'||id), d))::int AS visits, COUNT(*)::int AS services,
              COALESCE(SUM(amt),0)::numeric AS check_sum,
              COUNT(DISTINCT client_id)::int AS clients,
              COUNT(DISTINCT client_id) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM appointments p WHERE p.master_id=$1 AND p.client_id=vis.client_id
                   AND p.starts_at < ($2||' 00:00:00+03')::timestamptz
                   AND p.status IN ('done','completed','confirmed')))::int AS new_clients
         FROM vis`, [mid, from, next])).rows[0];

    const st = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status IN ('noshow','no_show'))::int AS noshow,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ends_at, starts_at + INTERVAL '1 hour') - starts_at))/60)
                FILTER (WHERE COALESCE(status,'') NOT IN ('cancelled','noshow','no_show')),0)::int AS booked_min
         FROM appointments
        WHERE master_id=$1 AND starts_at >= ($2||' 00:00:00+03')::timestamptz AND starts_at < ($3||' 00:00:00+03')::timestamptz`,
      [mid, from, next])).rows[0];
    const sh = (await pool.query(
      `SELECT COUNT(*)::int AS days,
              COALESCE(SUM(EXTRACT(EPOCH FROM (end_time - start_time))/60),0)::int AS min
         FROM master_schedule_days
        WHERE master_id=$1 AND start_time IS NOT NULL AND end_time > start_time
          AND work_date >= $2::date AND work_date < $3::date`, [mid, from, next])).rows[0];
    const rv = (await pool.query(
      `SELECT COUNT(*)::int AS n, ROUND(AVG(rating)::numeric,2)::float AS avg,
              COUNT(*) FILTER (WHERE created_at >= ($2||' 00:00:00+03')::timestamptz AND created_at < ($3||' 00:00:00+03')::timestamptz)::int AS month_n
         FROM reviews WHERE master_id=$1 AND status='published'`, [mid, from, next])).rows[0];
    const last = (await pool.query(
      `SELECT rating, LEFT(text,200) AS text, to_char(created_at AT TIME ZONE 'Europe/Kyiv','DD.MM') AS d
         FROM reviews WHERE master_id=$1 AND status='published' ORDER BY created_at DESC LIMIT 3`, [mid])).rows;

    const visits = v.visits;
    res.json({
      ok: true, month, current: month === cur,
      upcoming: { today: upcoming.today, tomorrow: upcoming.tomorrow, week: upcoming.week },
      money: { revenue: est.services_revenue, earned: est.total, percent_part: est.percent_part,
        fixed_part: est.fixed_part, sales_part: est.sales_part, scheme: est.scheme, services_count: est.services_count },
      visits, services: v.services, clients: v.clients, new_clients: v.new_clients, repeat_clients: Math.max(0, v.clients - v.new_clients),
      avg_check: visits ? Math.round(Number(v.check_sum) / visits) : 0,
      load: { booked_min: st.booked_min, shift_min: sh.min, shift_days: sh.days,
        pct: sh.min ? Math.min(100, Math.round(st.booked_min * 100 / sh.min)) : null },
      cancelled: st.cancelled, noshow: st.noshow,
      reviews: { count: rv.n, avg: rv.avg, month: rv.month_n, last },
    });
  } catch (e) { console.error('me/stats', e); res.status(500).json({ error: 'internal' }); }
});

// ── Клієнти на сьогодні з контактами (покращення 03.11) ────────────
// Лише свої записи на сьогодні; маскування телефонів — за налаштуванням салону.
router.get('/today', async (req, res) => {
  try {
    const mask = await shouldMaskPhones(req.user);
    const r = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status,
              COALESCE(s.name_ua, s.name, a.services_text) AS service,
              COALESCE(c.name, a.client_name, 'Клієнт') AS client,
              c.phone, c.telegram_id IS NOT NULL AS has_tg, c.tg_username,
              (a.real_amount IS NOT NULL OR a.real_synced_at IS NOT NULL) AS paid
         FROM appointments a
         LEFT JOIN services s ON s.id=a.service_id
         LEFT JOIN clients c ON c.id=a.client_id
        WHERE a.master_id=$1 AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = ${KYIV}::date
        ORDER BY a.starts_at`, [req.mid]);
    res.json({ ok: true, items: r.rows.map((x) => ({
      id: x.id, starts_at: x.starts_at, ends_at: x.ends_at, status: x.status, service: x.service, client: x.client,
      phone: x.phone ? (mask ? maskPhone(x.phone) : '+' + String(x.phone).replace(/\D/g, '')) : null,
      tg_username: mask ? null : (x.tg_username || null), paid: x.paid,
      can_noshow: ['booked', 'confirmed'].includes(x.status) && !x.paid && new Date(x.starts_at) <= new Date(),
    })), masked: !!mask });
  } catch (e) { console.error('me/today', e); res.status(500).json({ error: 'internal' }); }
});

// ── «Не прийшов» (покращення 03.11) ──────────────────────────────
// Лише СВІЙ запис СЬОГОДНІ, час уже настав, статус booked/confirmed, оплати не було.
// Ставить noshow (його вже розуміють журнал, відомість і нагадування). Каса/зарплата не чіпаються:
// noshow і так виключений з розрахунку. Помилку можна скасувати протягом дня (назад у попередній статус).
router.post('/appointments/:id/noshow', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
    const undo = req.body && req.body.undo === true;
    const r = undo
      ? await pool.query(
        `UPDATE appointments a SET status = COALESCE((SELECT meta->>'prev' FROM audit_log l
                  WHERE l.entity='appointment' AND l.entity_id=$1 AND l.action='appointment.noshow_by_master'
                  ORDER BY l.id DESC LIMIT 1),'booked'), updated_at=NOW()
          WHERE a.id=$1 AND a.master_id=$2 AND a.status='noshow'
            AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = ${KYIV}::date
          RETURNING a.id, a.status`, [id, req.mid])
      : await pool.query(
        `WITH prev AS (SELECT status FROM appointments WHERE id=$1)
         UPDATE appointments a SET status='noshow', updated_at=NOW()
          WHERE a.id=$1 AND a.master_id=$2 AND a.status IN ('booked','confirmed')
            AND a.real_amount IS NULL AND a.real_synced_at IS NULL
            AND a.starts_at <= NOW() AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = ${KYIV}::date
          RETURNING a.id, a.status, (SELECT status FROM prev) AS prev`, [id, req.mid]);
    if (!r.rowCount) return res.status(403).json({ error: 'forbidden', message: 'Можна позначити лише свій сьогоднішній неоплачений запис.' });
    await pool.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES ($1,$2,$3,'appointment',$4,NULL,$5)`,
      [req.user.id || null, req.user.display_name || 'master', undo ? 'appointment.noshow_undo_by_master' : 'appointment.noshow_by_master',
        id, JSON.stringify({ master_id: req.mid, prev: r.rows[0].prev || null })]).catch(() => {});
    res.json({ ok: true, id, status: r.rows[0].status });
  } catch (e) { console.error('me/noshow', e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
