/* routes/booking-catalog.js — публічний каталог для онлайн-запису (БЕЗ авторизації).
   Джерело правди — НАША БД: послуги + реальна звʼязка майстер↔послуга (master_services).
   Віддає лише активних майстрів з увімкненим онлайн-записом, що реально надають послугу.
   id послуг/майстрів = beautypro_id (GUID) щоб /slots на booking-api приймав їх напряму. */
const express = require('express');
const { getPool } = require('../db-pg');
const router = express.Router();
const pool = getPool();

router.get('/catalog', async (req, res) => {
  try {
    const svc = await pool.query(`
      SELECT COALESCE(beautypro_id::text,'svc-'||id) AS id, name,
             COALESCE(name_ua,name) AS name_ua, duration_min AS duration,
             price::float AS price, category, color, photo_urls
        FROM services
       WHERE active IS NOT FALSE AND deleted_at IS NULL
       ORDER BY sort_order NULLS LAST, name`);

    const mst = await pool.query(`
      SELECT COALESCE(m.beautypro_id::text,'mst-'||m.id) AS id,
             COALESCE(NULLIF(m.online_title,''), m.name) AS name,
             m.specialty, m.avatar, m.online_rank,
             COALESCE(
               json_agg(COALESCE(s.beautypro_id::text,'svc-'||s.id))
                 FILTER (WHERE s.id IS NOT NULL), '[]'
             ) AS services
        FROM masters m
        JOIN master_services ms ON ms.master_id = m.id AND ms.active IS NOT FALSE
        JOIN services s ON s.id = ms.service_id AND s.active IS NOT FALSE AND s.deleted_at IS NULL
       WHERE m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE
       GROUP BY m.id
       ORDER BY m.online_rank NULLS LAST, name`);

    res.set('Cache-Control', 'public, max-age=120');
    res.json({ services: svc.rows, masters: mst.rows, source: 'crm-db' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
