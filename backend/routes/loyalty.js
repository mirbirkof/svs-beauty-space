// Программа лояльности: уровни, рефералы, бонусы ко дню рождения
const express = require('express');
const router = express.Router();
const {Client} = require('pg');

const DB = process.env.DATABASE_URL;
const pool = new (require('pg').Pool)({ connectionString: DB, max: 5 });

function normalizePhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('80') && d.length === 11) d = '3' + d;
  if (d.length === 10) d = '38' + d;
  return d.length === 12 ? '+' + d : null;
}

// === ТАРИФЫ ===
router.get('/loyalty/tiers', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM loyalty_tiers ORDER BY min_spent');
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ПРОФИЛЬ КЛИЕНТА ===
router.get('/loyalty/profile/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'bad phone' });

    // 1. посчитать сумму трат из online_orders + online_bookings
    const spent = await pool.query(
      `SELECT
         COALESCE((SELECT total_spent FROM clients WHERE phone=$1 LIMIT 1), 0) +
         COALESCE((SELECT SUM(o.total) FROM orders o JOIN clients c ON c.id=o.client_id
                   WHERE c.phone=$1 AND o.status IN ('paid','completed','delivered')), 0) +
         COALESCE((SELECT SUM(s.price) FROM online_bookings ob LEFT JOIN services s ON s.id::text=ob.service_id
                   WHERE ob.client_phone=$1 AND ob.status IN ('confirmed','completed')), 0) AS total`,
      [phone]
    );
    const total = parseFloat(spent.rows[0].total || 0);

    // 2. определить tier
    const tier = await pool.query(
      'SELECT * FROM loyalty_tiers WHERE min_spent <= $1 ORDER BY min_spent DESC LIMIT 1',
      [total]
    );
    const t = tier.rows[0] || { name: 'Bronze', bonus_percent: 3 };

    // 3. сохранить в кеш
    await pool.query(
      `INSERT INTO client_loyalty (client_phone, total_spent, tier_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (client_phone) DO UPDATE SET total_spent=$2, tier_name=$3, updated_at=NOW()`,
      [phone, total, t.name]
    );

    // 4. рефералы
    const ref = await pool.query(
      `SELECT COUNT(*)::int AS invited_count,
              COALESCE(SUM(CASE WHEN bonus_credited THEN bonus_amount ELSE 0 END), 0)::numeric AS earned
       FROM referrals WHERE referrer_phone=$1`,
      [phone]
    );

    // 5. следующий уровень
    const next = await pool.query(
      'SELECT * FROM loyalty_tiers WHERE min_spent > $1 ORDER BY min_spent ASC LIMIT 1',
      [total]
    );

    res.json({
      ok: true,
      phone,
      total_spent: total,
      current_tier: t,
      next_tier: next.rows[0] || null,
      to_next: next.rows[0] ? Math.max(0, parseFloat(next.rows[0].min_spent) - total) : 0,
      referrals: {
        invited_count: ref.rows[0].invited_count,
        bonuses_earned: parseFloat(ref.rows[0].earned)
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === РЕФЕРАЛЫ ===
router.post('/loyalty/referrals', async (req, res) => {
  try {
    const referrer = normalizePhone(req.body.referrer_phone);
    const invited = normalizePhone(req.body.invited_phone);
    if (!referrer || !invited) return res.status(400).json({ error: 'bad phones' });
    if (referrer === invited) return res.status(400).json({ error: 'self-referral not allowed' });

    const r = await pool.query(
      `INSERT INTO referrals (referrer_phone, invited_phone, bonus_amount)
       VALUES ($1, $2, $3) RETURNING id`,
      [referrer, invited, req.body.bonus_amount || 100]
    );
    // зафиксировать invited_by в client_loyalty
    await pool.query(
      `INSERT INTO client_loyalty (client_phone, invited_by, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (client_phone) DO UPDATE SET invited_by=$2, updated_at=NOW()`,
      [invited, referrer]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'already invited' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/loyalty/referrals/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'bad phone' });
    const r = await pool.query(
      `SELECT id, invited_phone, bonus_amount, bonus_credited, invited_first_purchase_at, created_at
       FROM referrals WHERE referrer_phone=$1 ORDER BY created_at DESC`,
      [phone]
    );
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Кредитнуть бонус (после первой покупки приглашённого)
router.post('/loyalty/referrals/:id/credit', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE referrals SET bonus_credited=true, invited_first_purchase_at=COALESCE(invited_first_purchase_at, NOW())
       WHERE id=$1 AND bonus_credited=false RETURNING referrer_phone, bonus_amount`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'not found or already credited' });
    res.json({ ok: true, referrer: r.rows[0].referrer_phone, bonus: r.rows[0].bonus_amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ДНИ РОЖДЕНИЯ ===
router.post('/loyalty/birthday', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.client_phone);
    const birthday = req.body.birthday;
    if (!phone || !birthday) return res.status(400).json({ error: 'phone + birthday required' });
    await pool.query(
      `INSERT INTO client_loyalty (client_phone, birthday, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (client_phone) DO UPDATE SET birthday=$2, updated_at=NOW()`,
      [phone, birthday]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Кредитнуть бонус ко дню рождения (вызывается воркером раз в день)
router.post('/loyalty/birthday/credit', async (req, res) => {
  try {
    const today = new Date();
    const m = today.getMonth() + 1, d = today.getDate(), y = today.getFullYear();
    // найти всех у кого ДР сегодня и ещё нет начисления за этот год
    const cl = await pool.query(
      `SELECT cl.client_phone, cl.tier_name, lt.bonus_percent
       FROM client_loyalty cl
       LEFT JOIN loyalty_tiers lt ON lt.name = cl.tier_name
       WHERE EXTRACT(MONTH FROM cl.birthday) = $1
         AND EXTRACT(DAY FROM cl.birthday) = $2
         AND NOT EXISTS (SELECT 1 FROM birthday_bonuses WHERE client_phone=cl.client_phone AND year=$3)`,
      [m, d, y]
    );
    const credited = [];
    for (const row of cl.rows) {
      const bonus = parseFloat(row.bonus_percent || 3) * 50; // подарок = tier% × 50
      await pool.query(
        `INSERT INTO birthday_bonuses (client_phone, bonus_amount, year) VALUES ($1, $2, $3)`,
        [row.client_phone, bonus, y]
      );
      credited.push({ phone: row.client_phone, bonus });
    }
    res.json({ ok: true, credited_count: credited.length, items: credited });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
