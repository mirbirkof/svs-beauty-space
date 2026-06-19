/* routes/ai-sales.js — AI-02 AI Sales (прагматична версія для 1 салону).
   Без таблиць offers/rules/winback, що нікому не наповнюються (немає авто-pipeline розсилки).
   Уся цінність рахується на льоту з реальних даних:
     - середній чек, частка мультисервісних візитів (потенціал крос-селу),
     - топ-комбо послуг за виручкою (готові бандли для маркетингу),
     - конверсія по майстрах (хто допродає краще),
     - оцінка втраченої виручки якщо підтягнути мультисервіс до лідера.
   Персональні offer'и для оператора = upsell (дорожча послуга в тій же категорії,
   яку клієнт ще не брав) + cross-sell (делегуємо рушію AI-07 recommendations).

   Ендпоінти:
     GET /api/ai/sales/analytics            — дашборд продажів (reports.finance)
     GET /api/ai/sales/recommend/:client_id — upsell+cross-sell для оператора (reports.read)
   Win-back уже покритий AI-07 /reactivation, рушій рекомендацій — AI-07. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

const WINDOW_DAYS = 180;

// ── GET /analytics ─────────────────────────────────────────
router.get('/analytics', requirePerm('reports.finance'), async (req, res) => {
  try {
    const W = Math.min(Math.max(parseInt(req.query.days, 10) || WINDOW_DAYS, 30), 730);
    const [overall, byMaster, combos] = await Promise.all([
      // візит = клієнт + день; чек = сума price послуг візиту
      pool.query(`
        WITH visits AS (
          SELECT client_id, starts_at::date d, COUNT(*) svc, SUM(COALESCE(real_amount,price)) tot
            FROM appointments
           WHERE status='done' AND price>0 AND starts_at >= NOW() - ($1 || ' days')::interval
           GROUP BY client_id, starts_at::date
        )
        SELECT COUNT(*)::int visits,
               ROUND(AVG(tot))::int avg_check,
               ROUND(AVG(svc), 2)::float avg_services,
               ROUND(100.0 * COUNT(*) FILTER (WHERE svc>=2) / NULLIF(COUNT(*),0), 1)::float multi_pct,
               ROUND(SUM(tot))::bigint revenue
          FROM visits`, [W]).then(r => r.rows[0] || {}).catch(() => ({})),
      pool.query(`
        WITH visits AS (
          SELECT master_id, client_id, starts_at::date d, SUM(COALESCE(real_amount,price)) tot, COUNT(*) svc
            FROM appointments
           WHERE status='done' AND price>0 AND starts_at >= NOW() - ($1 || ' days')::interval
           GROUP BY master_id, client_id, starts_at::date
        )
        SELECT m.name,
               COUNT(*)::int visits,
               ROUND(AVG(v.tot))::int avg_check,
               ROUND(100.0 * COUNT(*) FILTER (WHERE v.svc>=2) / NULLIF(COUNT(*),0), 1)::float multi_pct
          FROM visits v JOIN masters m ON m.id=v.master_id
         GROUP BY m.name HAVING COUNT(*) >= 10
         ORDER BY avg_check DESC`, [W]).then(r => r.rows).catch(() => []),
      pool.query(`
        WITH pairs AS (
          SELECT a.service_id s1, b.service_id s2, (a.price + b.price) val
            FROM appointments a
            JOIN appointments b ON a.client_id=b.client_id AND a.starts_at::date=b.starts_at::date AND a.service_id < b.service_id
           WHERE a.status='done' AND b.status='done' AND a.price>0 AND b.price>0
             AND a.starts_at >= NOW() - ($1 || ' days')::interval
        )
        SELECT sa.name n1, sb.name n2, COUNT(*)::int cnt, ROUND(SUM(val))::int revenue
          FROM pairs p LEFT JOIN services sa ON sa.id=p.s1 LEFT JOIN services sb ON sb.id=p.s2
         GROUP BY sa.name, sb.name
         ORDER BY revenue DESC LIMIT 8`, [W]).then(r => r.rows).catch(() => []),
    ]);

    // оцінка потенціалу крос-селу: більшість візитів — одна послуга.
    // Якщо допродати додаткову послугу хоча б частині з них — додаткова виручка.
    const curMulti = overall.multi_pct || 0;
    const visits = overall.visits || 0;
    const avgCheck = overall.avg_check || 0;
    const singleVisits = Math.round(visits * (1 - curMulti / 100));
    const CONVERT_RATE = 0.10;            // консервативно: 10% одиночних візитів
    const ADDON_SHARE = 0.40;             // додаткова послуга ≈ 40% від середнього чека
    const extraVisits = Math.round(singleVisits * CONVERT_RATE);
    const opportunity = Math.round(extraVisits * avgCheck * ADDON_SHARE);

    res.json({
      ok: true,
      window_days: W,
      overall: {
        visits, avg_check: avgCheck,
        avg_services: overall.avg_services || 0,
        multi_service_pct: curMulti,
        revenue: Number(overall.revenue || 0),
      },
      by_master: byMaster.map(m => ({
        name: m.name, visits: m.visits, avg_check: m.avg_check, multi_service_pct: m.multi_pct,
      })),
      top_combos: combos.map(c => ({
        a: c.n1 || '—', b: c.n2 || '—', count: c.cnt, revenue: c.revenue,
      })),
      cross_sell_opportunity: {
        current_multi_pct: curMulti,
        single_service_pct: Math.round((100 - curMulti) * 10) / 10,
        single_service_visits: singleVisits,
        potential_extra_visits: extraVisits,
        potential_revenue: opportunity,
        hint: opportunity > 0
          ? `${Math.round(100 - curMulti)}% візитів — лише одна послуга. Якщо допродати додаткову послугу хоча б 10% із них — орієнтовно +${opportunity.toLocaleString('uk-UA')} грн`
          : 'Майже всі візити вже мультисервісні',
      },
    });
  } catch (e) {
    console.error('[ai-sales:analytics]', e); res.status(500).json({ error: 'internal' });
  }
});

// ── GET /recommend/:client_id — для оператора/майстра ──────
router.get('/recommend/:client_id', requirePerm('reports.read'), async (req, res) => {
  try {
    const cid = parseInt(req.params.client_id, 10);
    if (!cid) return res.status(400).json({ error: 'bad_id' });

    // що клієнт уже брав (по категоріях і конкретних послугах)
    const mine = await pool.query(
      `SELECT DISTINCT a.service_id, s.category, s.price
         FROM appointments a JOIN services s ON s.id=a.service_id
        WHERE a.client_id=$1 AND a.status='done' AND a.service_id IS NOT NULL`, [cid]
    ).then(r => r.rows).catch(() => []);
    const myIds = mine.map(m => m.service_id);
    const myCats = [...new Set(mine.map(m => m.category).filter(Boolean))];

    // UPSELL: дорожча послуга в категорії, яку клієнт уже відвідує, але цю ще не брав
    let upsell = [];
    if (myCats.length) {
      upsell = await pool.query(`
        SELECT s.id, s.name, s.category, s.price
          FROM services s
         WHERE s.active=true AND s.category = ANY($1)
           ${myIds.length ? 'AND s.id <> ALL($2)' : ''}
           AND s.price > COALESCE((
             SELECT AVG(price) FROM appointments WHERE client_id=$3 AND status='done' AND service_id IS NOT NULL
           ), 0)
         ORDER BY s.price DESC LIMIT 3`,
        myIds.length ? [myCats, myIds, cid] : [myCats, cid]).then(r => r.rows).catch(() => []);
    }

    // CROSS-SELL: co-occurrence (послуги, які беруть разом клієнти з тим самим набором)
    let crossSell = [];
    if (myIds.length) {
      crossSell = await pool.query(`
        WITH cs AS (
          SELECT DISTINCT client_id, service_id FROM appointments
           WHERE status='done' AND service_id IS NOT NULL AND client_id IS NOT NULL
        )
        SELECT b.service_id, s.name, s.price, COUNT(DISTINCT a.client_id)::int score
          FROM cs a JOIN cs b ON a.client_id=b.client_id
          LEFT JOIN services s ON s.id=b.service_id
         WHERE a.service_id = ANY($1) AND b.service_id <> ALL($1) AND a.client_id<>$2
         GROUP BY b.service_id, s.name, s.price
         ORDER BY score DESC LIMIT 4`, [myIds, cid]).then(r => r.rows).catch(() => []);
    }

    const offers = [
      ...upsell.map(u => ({
        type: 'upsell',
        service_id: u.id,
        name: u.name || `Послуга #${u.id}`,
        price: u.price != null ? Math.round(Number(u.price)) : null,
        reason: `Преміум-послуга в категорії «${u.category}», яку клієнт відвідує`,
      })),
      ...crossSell.map(c => ({
        type: 'cross_sell',
        service_id: c.service_id,
        name: c.name || `Послуга #${c.service_id}`,
        price: c.price != null ? Math.round(Number(c.price)) : null,
        reason: 'Часто беруть разом клієнти зі схожими послугами',
        score: c.score,
      })),
    ];

    res.json({ ok: true, client_id: cid, offers });
  } catch (e) {
    console.error('[ai-sales:recommend]', e); res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
