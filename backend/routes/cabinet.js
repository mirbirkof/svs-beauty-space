/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Cabinet Content (M20)
   Все endpoints под Bearer-токеном клиента (cabinet-auth).

   GET /api/cabinet/visits   → визиты: майбутні + історія (BeautyPro sync)
   GET /api/cabinet/orders   → замовлення магазину + статус оплати
   GET /api/cabinet/loyalty  → бонуси: баланс, рівень, до наступного
   GET /api/cabinet/summary  → зведення для головної кабінету
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { authClient } = require('./cabinet-auth');

const router = express.Router();

// ── визиты: будущие + история ──
router.get('/visits', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.price, a.status,
              s.name AS service, m.name AS master
       FROM appointments a
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN masters m ON m.id = a.master_id
       WHERE a.client_id = $1
       ORDER BY a.starts_at DESC
       LIMIT $2 OFFSET $3`,
      [req.client.id, limit, offset]
    );
    const now = Date.now();
    const upcoming = [], past = [];
    for (const v of r.rows) {
      (new Date(v.starts_at).getTime() >= now ? upcoming : past).push(v);
    }
    upcoming.reverse(); // ближайший первым
    res.json({ ok: true, upcoming, past, total: r.rowCount });
  } catch (e) {
    console.error('[cabinet:visits]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── заказы магазина ──
router.get('/orders', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT o.id, o.total, o.status, o.created_at, o.delivery_type,
              COALESCE(json_agg(json_build_object(
                'name', oi.product_name, 'qty', oi.qty, 'price', oi.unit_price
              ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
              (SELECT p.status FROM payments p
                WHERE p.order_id = o.id AND p.provider = 'mono'
                ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.client_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.client.id, limit, offset]
    );
    res.json({ ok: true, orders: r.rows });
  } catch (e) {
    console.error('[cabinet:orders]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── бонусы и уровень лояльности ──
async function loyaltyFor(client) {
  const pool = getPool();
  const phone = String(client.phone || '').replace(/\D/g, '');

  // баланс бонусов из ledger
  const bal = await pool.query(
    `SELECT COALESCE(SUM(delta), 0)::numeric AS balance FROM loyalty_ledger WHERE client_id = $1`,
    [client.id]
  );

  // потрачено всего: max(total_spent из BeautyPro, сумма прошедших визитов) + оплаченные заказы
  // (GREATEST — чтобы не задвоить, если BeautyPro начнёт отдавать total_spent)
  const spent = await pool.query(
    `SELECT
       GREATEST(
         COALESCE((SELECT total_spent FROM clients WHERE id = $1), 0),
         COALESCE((SELECT SUM(COALESCE(real_amount, price)) FROM appointments
                   WHERE client_id = $1 AND starts_at < NOW() AND status NOT IN ('cancelled')), 0)
       ) +
       COALESCE((SELECT SUM(total) FROM orders WHERE client_id = $1 AND status IN ('paid','completed','delivered')), 0) AS total`,
    [client.id]
  );
  const total = parseFloat(spent.rows[0].total || 0);

  const tier = await pool.query(
    `SELECT name, bonus_percent, min_spent FROM loyalty_tiers WHERE min_spent <= $1 ORDER BY min_spent DESC LIMIT 1`,
    [total]
  );
  const next = await pool.query(
    `SELECT name, bonus_percent, min_spent FROM loyalty_tiers WHERE min_spent > $1 ORDER BY min_spent ASC LIMIT 1`,
    [total]
  );
  return {
    balance: parseFloat(bal.rows[0].balance),
    total_spent: total,
    tier: tier.rows[0] || { name: 'Bronze', bonus_percent: 3 },
    next_tier: next.rows[0] || null,
    to_next: next.rows[0] ? Math.max(0, parseFloat(next.rows[0].min_spent) - total) : 0,
    phone,
  };
}

router.get('/loyalty', authClient(), async (req, res) => {
  try {
    res.json({ ok: true, ...(await loyaltyFor(req.client)) });
  } catch (e) {
    console.error('[cabinet:loyalty]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── зведення для головної кабінету ──
router.get('/summary', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const [nextVisit, lastOrder, loyal] = await Promise.all([
      pool.query(
        `SELECT a.starts_at, s.name AS service, m.name AS master
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN masters m ON m.id = a.master_id
         WHERE a.client_id = $1 AND a.starts_at >= NOW() AND a.status NOT IN ('cancelled')
         ORDER BY a.starts_at ASC LIMIT 1`,
        [req.client.id]
      ),
      pool.query(
        `SELECT id, total, status, created_at FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [req.client.id]
      ),
      loyaltyFor(req.client),
    ]);
    res.json({
      ok: true,
      client: { name: req.client.name, phone: req.client.phone },
      next_visit: nextVisit.rows[0] || null,
      last_order: lastOrder.rows[0] || null,
      loyalty: loyal,
    });
  } catch (e) {
    console.error('[cabinet:summary]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
