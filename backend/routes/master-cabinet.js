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
const router = express.Router();
const pool = getPool();

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
    res.json({ ok: true, master: r.rows[0] || null });
  } catch (e) { console.error('me/profile', e); res.status(500).json({ error: 'internal' }); }
});

// ── Мої клієнти ───────────────────────────────────────────
// Унікальні клієнти, що були в цього майстра. Сума — по фактично сплаченому
// (COALESCE(real_amount, price)), а не плановій ціні.
router.get('/clients', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
          COALESCE(c.id, 0)                                      AS client_id,
          COALESCE(c.name, a.client_name, 'Без імені')           AS name,
          c.phone,
          COUNT(*) FILTER (WHERE a.status IN ('done','confirmed','completed'))::int AS visits,
          MAX(a.starts_at)                                        AS last_visit,
          COALESCE(SUM(
            CASE WHEN a.status IN ('done','confirmed','completed')
                 THEN COALESCE(a.real_amount, a.price) ELSE 0 END
          ), 0)::numeric                                          AS spent
        FROM appointments a
        LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.master_id = $1
       GROUP BY COALESCE(c.id, 0), COALESCE(c.name, a.client_name, 'Без імені'), c.phone
       ORDER BY last_visit DESC NULLS LAST
       LIMIT 500`, [req.mid]);
    res.json({ ok: true, items: r.rows, count: r.rows.length });
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

module.exports = router;
